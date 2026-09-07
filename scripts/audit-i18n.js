import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export async function runStaticAudit(customBaseDir = null) {
  const baseDir = customBaseDir || ROOT_DIR;
  const i18nPath = path.join(baseDir, 'packages/web-ui/src/static/i18n.js');
  const chatReportPath = path.join(baseDir, 'reports/i18n-chat-keys.md');
  const mgmtReportPath = path.join(baseDir, 'reports/i18n-management-keys.md');
  const appJsPath = path.join(baseDir, 'packages/web-ui/src/static/app.js');
  const indexHtmlPath = path.join(baseDir, 'packages/web-ui/src/static/index.html');

  const i18n = await import(pathToFileURL(i18nPath).href);
  const en = i18n.en;
  const zh = i18n.zhCN;

  function clean(str) {
    if (!str) return '';
    return str.replace(/^\`+|\`+$/g, '').trim();
  }

  function parseMarkdownManifest(filePath) {
    const md = fs.readFileSync(filePath, 'utf-8');
    const lines = md.split('\n');
    const items = [];
    let inTable = false;
    let headers = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
        if (cells.every(c => /^:?-+:?$/.test(c))) {
          inTable = true;
          continue;
        }
        if (!inTable) {
          headers = cells.map(c => c.toLowerCase());
        } else {
          const row = {};
          headers.forEach((h, i) => {
            row[h] = cells[i] || '';
          });

          let key = '';
          let enVal = '';
          let zhVal = '';

          for (const [k, v] of Object.entries(row)) {
            if (k.includes('key') && !k.includes('route') && !k.includes('api')) {
              key = clean(v);
            } else if (k.includes('english') || k.includes('(en)')) {
              enVal = clean(v);
            } else if (k.includes('chinese') || k.includes('(zh-cn)')) {
              zhVal = clean(v);
            }
          }

          if (key && (key.includes('.') || key.startsWith('common') || key.startsWith('chat') || key.startsWith('management') || key.startsWith('section') || key.startsWith('modal') || key.startsWith('toast') || key.startsWith('error') || key.startsWith('overview') || key.startsWith('runtime') || key.startsWith('plugins') || key.startsWith('tasks') || key.startsWith('profiles') || key.startsWith('files') || key.startsWith('quotas') || key.startsWith('reconcile') || key.startsWith('users') || key.startsWith('models') || key.startsWith('status') || key.startsWith('account') || key.startsWith('auth'))) {
            items.push({ key, en: enVal, zh: zhVal, source: filePath });
          }
        }
      } else {
        inTable = false;
        headers = [];
      }
    }
    return items;
  }

  const chatManifest = parseMarkdownManifest(chatReportPath);
  const mgmtManifest = parseMarkdownManifest(mgmtReportPath);
  const allManifest = [...chatManifest, ...mgmtManifest];

  const manifestMap = new Map();
  allManifest.forEach(item => manifestMap.set(item.key, item));

  // 1. Manifest completeness & symmetry
  const missingManifestInEn = [];
  const missingManifestInZh = [];
  const emptyManifestInEn = [];
  const emptyManifestInZh = [];

  for (const [key, item] of manifestMap.entries()) {
    if (en[key] === undefined) missingManifestInEn.push(key);
    else if (typeof en[key] !== 'string' || en[key].trim() === '') emptyManifestInEn.push(key);

    if (zh[key] === undefined) missingManifestInZh.push(key);
    else if (typeof zh[key] !== 'string' || zh[key].trim() === '') emptyManifestInZh.push(key);
  }

  const enKeys = Object.keys(en);
  const zhKeys = Object.keys(zh);
  const enOnly = enKeys.filter(k => zh[k] === undefined);
  const zhOnly = zhKeys.filter(k => en[k] === undefined);

  // 2. Extract from app.js & index.html
  const appJs = fs.readFileSync(appJsPath, 'utf-8');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

  const literalKeys = new Set();
  const dynamicCalls = [];

  // t('key') or t("key")
  const tRegex = /\bt\(\s*([^,\)]+)(?:,\s*([^,\)]+))?(?:,\s*([^\)]+))?\)/g;
  let m;
  while ((m = tRegex.exec(appJs)) !== null) {
    const rawArg = m[1].trim();
    const litMatch = /^['"]([a-zA-Z0-9_\.\-]+)['"]$/.exec(rawArg);
    if (litMatch) {
      literalKeys.add(litMatch[1]);
    } else {
      dynamicCalls.push({ call: m[0], expr: rawArg });
    }
  }

  // tr('key') or tr("key")
  const trRegex = /\btr\(\s*([^,\)]+)(?:,\s*([^,\)]+))?(?:,\s*([^\)]+))?\)/g;
  while ((m = trRegex.exec(appJs)) !== null) {
    const rawArg = m[1].trim();
    const litMatch = /^['"]([a-zA-Z0-9_\.\-]+)['"]$/.exec(rawArg);
    if (litMatch) {
      literalKeys.add(litMatch[1]);
    } else {
      dynamicCalls.push({ call: m[0], expr: rawArg });
    }
  }

  // data-i18n in HTML and JS
  const dataI18nRegex = /data-i18n(?:-[a-z]+)?=['"]([a-zA-Z0-9_\.\-]+)['"]/g;
  while ((m = dataI18nRegex.exec(indexHtml)) !== null) literalKeys.add(m[1]);
  while ((m = dataI18nRegex.exec(appJs)) !== null) literalKeys.add(m[1]);

  const missingAppInEn = [...literalKeys].filter(k => en[k] === undefined);
  const missingAppInZh = [...literalKeys].filter(k => zh[k] === undefined);

  const dynamicExpressions = [...new Set(dynamicCalls.map(d => d.expr))];

  return {
    manifestTotal: manifestMap.size,
    chatManifestCount: chatManifest.length,
    mgmtManifestCount: mgmtManifest.length,
    catalogTotalEn: enKeys.length,
    catalogTotalZh: zhKeys.length,
    missingManifestInEn,
    missingManifestInZh,
    emptyManifestInEn,
    emptyManifestInZh,
    enOnly,
    zhOnly,
    literalKeysCount: literalKeys.size,
    missingAppInEn,
    missingAppInZh,
    dynamicCallsCount: dynamicCalls.length,
    dynamicExpressions,
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runStaticAudit().then(res => {
    console.log(JSON.stringify(res, null, 2));
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
