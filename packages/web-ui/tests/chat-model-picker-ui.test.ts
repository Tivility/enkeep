import { describe, it, expect } from 'vitest';
import { getWebUiIndexHtml, getWebUiAsset } from '../src/index.js';
import { en, zhCN } from '../src/static/i18n.js';

describe('Chat Header Model & Effort Picker (Feature 07)', () => {
  const html = getWebUiIndexHtml();
  const appJsAsset = getWebUiAsset('app.js');
  const appJs = appJsAsset.content.toString('utf-8');
  const styleCssAsset = getWebUiAsset('style.css');
  const styleCss = styleCssAsset.content.toString('utf-8');

  it('1. verifies static DOM structure in index.html and style.css', () => {
    // Header trigger badge
    expect(html).toContain('id="session-model-badge"');
    expect(html).toContain('data-i18n-title="chat.modelTriggerTitle"');

    // Modal dialog
    expect(html).toContain('id="modal-session-model"');
    expect(html).toContain('id="form-session-model"');
    expect(html).toContain('id="session-model-effective"');
    expect(html).toContain('id="session-model-select"');
    expect(html).toContain('id="session-model-effort-group"');
    expect(html).toContain('id="session-model-effort-buttons"');
    expect(html).toContain('id="btn-session-model-reset"');
    expect(html).toContain('id="btn-submit-session-model"');

    // CSS styles for trigger and effort buttons
    expect(styleCss).toContain('#session-model-badge');
    expect(styleCss).toContain('.effort-btn-group');
    expect(styleCss).toContain('.effort-btn');
    expect(styleCss).toContain('.effort-btn.active');
  });

  it('2. verifies i18n translation keys in en and zh-CN catalogs', () => {
    // English keys
    expect(en['chat.modelTriggerTitle']).toBe('Inspect or switch effective model');
    expect(en['chat.modelPickerTitle']).toBe('Session Model & Reasoning Effort');
    expect(en['chat.modelEffectiveLabel']).toBe('Current Effective Model');
    expect(en['chat.modelSelectLabel']).toBe('Model Selection');
    expect(en['chat.effortSelectLabel']).toBe('Reasoning Effort');
    expect(en['chat.effortDefault']).toBe('Default');
    expect(en['chat.inheritDefault']).toBe('Inherit Default ({model})');
    expect(en['chat.btnResetOverride']).toBe('Restore Default');
    expect(en['chat.modelSwitchSuccess']).toBe('Model switched to {model}, takes effect on next turn.');
    expect(en['chat.modelResetSuccess']).toBe('Session override cleared, restored to default ({model}).');

    // Chinese keys
    expect(zhCN['chat.modelTriggerTitle']).toBe('查看或切换当前会话生效模型');
    expect(zhCN['chat.modelPickerTitle']).toBe('会话模型与推理深度');
    expect(zhCN['chat.modelEffectiveLabel']).toBe('当前生效模型');
    expect(zhCN['chat.modelSelectLabel']).toBe('选择模型');
    expect(zhCN['chat.effortSelectLabel']).toBe('推理深度 (Reasoning Effort)');
    expect(zhCN['chat.effortDefault']).toBe('默认');
    expect(zhCN['chat.inheritDefault']).toBe('跟随默认配置 ({model})');
    expect(zhCN['chat.btnResetOverride']).toBe('恢复默认');
    expect(zhCN['chat.modelSwitchSuccess']).toBe('已切换模型为 {model}，将在下一轮对话生效。');
    expect(zhCN['chat.modelResetSuccess']).toBe('已清除会话覆盖，恢复为默认模型 ({model})。');
  });

  it('3. verifies app.js integration and handlers', () => {
    // Model picker logic functions
    expect(appJs).toContain('function syncSessionModelBadge');
    expect(appJs).toContain('function openSessionModelModal');
    expect(appJs).toContain('function handleSaveSessionModel');
    expect(appJs).toContain('function handleResetSessionModel');

    // Lifecycle integration in selectSession / deselectSession
    expect(appJs).toContain('syncSessionModelBadge(sessionId)');
    expect(appJs).toContain('modelBadge.classList.add("hidden")');

    // API endpoints called
    expect(appJs).toContain('/api/models');
    expect(appJs).toContain('/api/models/effective');
    expect(appJs).toContain('/api/sessions/${encodeURIComponent(sessionId)}/model-override');
  });
});
