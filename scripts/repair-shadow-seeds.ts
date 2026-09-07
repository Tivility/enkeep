import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = __dirname.endsWith("dist/scripts") || __dirname.endsWith("dist/scripts/")
  ? path.resolve(__dirname, "../../")
  : path.resolve(__dirname, "../");

const TARGET_DB_PATH = path.join(REPO_ROOT, ".demo-data/platform.db");
const TARGET_USERNAME = "hpc_admin_shadow";
const HOST_RUNTIME_DIR = path.join(REPO_ROOT, ".demo-data/host-runtimes/hpc_admin_shadow");
const HOST_SPACES_DIR = path.join(HOST_RUNTIME_DIR, "spaces");
const HOST_SESSIONS_DIR = path.join(HOST_RUNTIME_DIR, "sessions");

function projectKey(cwd: string): string {
  if (!cwd || cwd.length === 0) return "_no-cwd";
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

async function run() {
  console.log("=== CANONICAL DSH SEED COMPILATION & FRESH IMPORT ===");

  const targetDb = new DatabaseSync(TARGET_DB_PATH);

  const targetUser = targetDb
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(TARGET_USERNAME) as any;
  if (!targetUser) throw new Error(`User ${TARGET_USERNAME} not found`);
  const targetUserId = targetUser.id;

  // 1. Resolve active profile snapshot object matching current route snapshot
  const activeSnapshotRow = targetDb
    .prepare("SELECT * FROM agent_profile_snapshots WHERE user_id = ? ORDER BY version DESC LIMIT 1")
    .get(targetUserId) as any;
  
  if (!activeSnapshotRow) throw new Error(`No active snapshot found for user ${targetUserId}`);

  const activeProfileSnapshotObj = {
    profileId: activeSnapshotRow.profile_id,
    version: activeSnapshotRow.version,
    promptHash: activeSnapshotRow.prompt_hash,
    identity: activeSnapshotRow.identity || "",
    soul: activeSnapshotRow.soul || "",
    agents: activeSnapshotRow.agents || "",
    tools: activeSnapshotRow.tools || "",
  };
  console.log("Canonical Route Profile Snapshot:", JSON.stringify(activeProfileSnapshotObj));

  // 2. Fetch all session routes and spaces
  const routes = targetDb
    .prepare("SELECT * FROM session_routes WHERE user_id = ? ORDER BY created_at ASC")
    .all(targetUserId) as any[];
  console.log(`Compiling seeds for ${routes.length} session routes.`);

  const spaces = targetDb
    .prepare("SELECT * FROM spaces WHERE user_id = ?")
    .all(targetUserId) as any[];
  const spaceMap = new Map<string, any>(spaces.map((s) => [s.id, s]));

  // 3. Compile canonical seeds from web_messages (excluding failed messages, user/assistant only)
  const importPayloads: Array<{
    sessionId: string;
    folder: string;
    seed: any[];
    profileSnapshot: any;
  }> = [];

  for (const route of routes) {
    const space = spaceMap.get(route.space_id);
    const folder = space?.folder || "main";

    // Query web_messages in chronological order
    const messages = targetDb
      .prepare(
        "SELECT * FROM web_messages WHERE session_id = ? AND user_id = ? AND status != 'failed' ORDER BY created_at ASC"
      )
      .all(route.id, targetUserId) as any[];

    const rawSeedEvents: any[] = [];
    let seq = 0;
    let turn = 1;
    let lastTime = Date.now();

    for (const msg of messages) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const parsedTime = Date.parse(msg.created_at);
      const stamp = Number.isSafeInteger(parsedTime) && parsedTime > 0 ? parsedTime : Date.now();
      lastTime = stamp;

      const contentText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

      if (msg.role === "user") {
        rawSeedEvents.push({
          type: "user/message",
          seq: seq++,
          time: stamp,
          surfaceOp: "append",
          data: {
            id: msg.id,
            role: "user",
            content: [{ type: "text", text: contentText }],
            source: { kind: "user" },
          },
        });
      } else if (msg.role === "assistant") {
        rawSeedEvents.push({
          type: "turn/start",
          seq: seq++,
          time: stamp,
          data: { turn },
        });
        rawSeedEvents.push({
          type: "step/start",
          seq: seq++,
          time: stamp,
          data: { turn, step: 1 },
        });
        rawSeedEvents.push({
          type: "assistant/message",
          seq: seq++,
          time: stamp,
          surfaceOp: "append",
          data: {
            turn,
            step: 1,
            message: {
              id: msg.id,
              role: "assistant",
              content: [{ type: "text", text: contentText }],
              source: { kind: "model", provider: "cpa-gpt", model: "gpt-5.6-sol" },
            },
          },
        });
        rawSeedEvents.push({
          type: "step/end",
          seq: seq++,
          time: stamp,
          data: { turn, step: 1 },
        });
        rawSeedEvents.push({
          type: "turn/end",
          seq: seq++,
          time: stamp,
          data: { turn, reason: { kind: "completed" } },
        });
        turn++;
      }
    }

    if (rawSeedEvents.length > 0) {
      rawSeedEvents.push({
        type: "session/end-seed",
        seq: seq++,
        time: lastTime,
        data: {},
      });
    }

    importPayloads.push({
      sessionId: route.id,
      folder,
      seed: rawSeedEvents,
      profileSnapshot: activeProfileSnapshotObj,
    });

    // Write to Host Sessions Directory for Host Runtime Daemon with valid SessionHeader if host mode
    if (space?.execution_mode === "host") {
      const hostSpacePath = path.join(HOST_SPACES_DIR, folder);
      const hostProjKey = projectKey(hostSpacePath);
      const firstMsgTime = rawSeedEvents[0]?.time ?? Date.now();
      const headerRecord = {
        type: "session",
        version: 0,
        id: route.id,
        createdAt: firstMsgTime,
        cwd: hostSpacePath,
        delegationDepth: 0,
        ...(rawSeedEvents.length > 0 ? { seedLength: rawSeedEvents.length } : {}),
      };
      const hostLines = [JSON.stringify(headerRecord), ...rawSeedEvents.map((ev) => JSON.stringify(ev))];
      const hostJsonlContent = hostLines.join("\n") + "\n";

      const hostNestedDir = path.join(HOST_SESSIONS_DIR, hostProjKey, route.id);
      if (!fs.existsSync(hostNestedDir)) {
        fs.mkdirSync(hostNestedDir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(path.join(hostNestedDir, "session.jsonl"), hostJsonlContent, "utf8");
    }
  }

  console.log(`Compiled ${importPayloads.length} canonical seeds.`);

  // 4. Locate Container & Reset Volume Storage
  const containerListOutput = execSync('docker ps --filter "name=hpc_admin_shadow" --format "{{.Names}}"').toString().trim();
  const containerName = containerListOutput.split("\n")[0] || "enkeep-demo-hpc_admin_shadow_42559a95";
  console.log(`Target Container: ${containerName}`);

  const volumeName = `enkeep-demo-dsh-${TARGET_USERNAME}_42559a95`;

  // Use helper alpine container to completely wipe session jsonls, receipts, locks, daemon-turns
  console.log("Wiping container volume sessions and receipt stores...");
  execSync(`docker run --rm -v ${volumeName}:/data alpine sh -c "rm -rf /data/.dsh/sessions/* /data/.dsh/data/* /data/.dsh/daemon-turns/* /data/.dsh/locks/*"`);

  // Ensure volume ownership is 1000:1000
  execSync(`docker run --rm -v ${volumeName}:/data alpine chown -R 1000:1000 /data`);

  // Restart container cleanly so daemon initializes with fresh state
  console.log("Restarting container to reload fresh daemon...");
  execSync(`docker restart ${containerName}`);

  // Wait for daemon socket readiness
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      execSync(`docker exec -i ${containerName} node --input-type=module -e '
        import net from "node:net";
        const s = net.connect("/tmp/enkeep-runtime.sock");
        s.on("connect", () => { s.end(); process.exit(0); });
        s.on("error", () => process.exit(1));
      '`);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) throw new Error("Container daemon socket did not become ready after restart");
  console.log("Daemon socket is ready.");

  // 5. Import seeds into container using container-side node importer with DaemonRpcEncoder/Decoder
  console.log("Importing all 59 canonical seeds via container daemon...");

  const writeProc = spawn("docker", ["exec", "-i", containerName, "sh", "-c", "cat > /tmp/import-payloads.json"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  writeProc.stdin.write(JSON.stringify(importPayloads));
  writeProc.stdin.end();
  await new Promise((res, rej) => {
    writeProc.on("close", (c) => (c === 0 ? res(null) : rej(new Error(`Failed to write payloads to container: ${c}`))));
  });
  console.log("Wrote import payloads to container /tmp/import-payloads.json.");

  // Execute container-side import runner
  const inContainerRunner = `
import fs from "node:fs";
import net from "node:net";
import { DaemonRpcDecoder, DaemonRpcEncoder } from "/app/runtime-runner/dist/runtime/daemon-protocol.js";

const raw = fs.readFileSync("/tmp/import-payloads.json", "utf8");
const payloads = JSON.parse(raw);

const socket = net.connect("/tmp/enkeep-runtime.sock");
const encoder = new DaemonRpcEncoder();
const decoder = new DaemonRpcDecoder();

encoder.pipe(socket);
socket.pipe(decoder);

let currentIndex = 0;
let successCount = 0;
let failCount = 0;

function sendNext() {
  if (currentIndex >= payloads.length) {
    console.log(JSON.stringify({ finished: true, successCount, failCount }));
    socket.end();
    fs.unlinkSync("/tmp/import-payloads.json");
    return;
  }
  const item = payloads[currentIndex];
  const req = {
    id: "req_repair_" + currentIndex,
    op: "importSeed",
    sessionId: item.sessionId,
    seed: item.seed,
    profileSnapshot: item.profileSnapshot,
    workspaceFolder: item.folder
  };
  encoder.write(req);
}

socket.on("connect", () => {
  sendNext();
});

decoder.on("data", (msg) => {
  if (msg.id && msg.id.startsWith("req_repair_")) {
    if (msg.ok) {
      successCount++;
    } else {
      failCount++;
      console.error("Import error for " + payloads[currentIndex].sessionId + ": " + JSON.stringify(msg.error));
    }
    currentIndex++;
    sendNext();
  }
});

socket.on("error", (err) => {
  console.error("Daemon socket error:", err);
  process.exit(1);
});
`;

  const runResult = execSync(
    `docker exec -i ${containerName} node --input-type=module -e '${inContainerRunner}'`
  ).toString().trim();

  console.log("Import Output:", runResult);
  const resultObj = JSON.parse(runResult.split("\n").pop()!);
  console.log(`\nImport Summary: Success = ${resultObj.successCount}, Failures = ${resultObj.failCount}`);

  if (resultObj.failCount > 0) {
    throw new Error(`FAIL-CLOSED: ${resultObj.failCount} seeds failed to import`);
  }

  // Ensure volume ownership is 1000:1000
  execSync(`docker run --rm -v ${volumeName}:/data alpine chown -R 1000:1000 /data`);
  console.log("Volume ownership verified as 1000:1000.");

  console.log("\n=== Canonical Repair Completed Successfully ===");
}

run().catch((err) => {
  console.error("Repair Error:", err);
  process.exit(1);
});
