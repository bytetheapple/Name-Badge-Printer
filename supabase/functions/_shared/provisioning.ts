// The server half of a guided printer setup.
//
// A provisioning session is a state machine that two parties advance: an admin
// in the browser does the steps that need hands on the printer, and the bridge
// does the steps that need to reach the printer's network. This module is the
// referee — it hands the bridge one step at a time and writes back what came
// of it. It never talks to a printer and never decides what a step does.
//
// Everything is scoped to the org the bridge token resolved to. A session id
// arriving from a bridge is only ever used as a filter alongside that org, so
// a compromised device cannot reach another tenant's setup.
import { REST, restHeaders } from "./bridge-auth.ts";

/** States where the bridge acts. Anything else is waiting on a person. */
export const BRIDGE_TASKS = ["discover", "configure", "wifi", "rediscover"] as const;
export type BridgeTask = typeof BRIDGE_TASKS[number];

/** Which secrets each step actually needs. A step is sent nothing else. */
const SECRETS_FOR: Record<BridgeTask, string[]> = {
  discover: [],
  configure: ["web_password"],
  wifi: ["web_password", "wifi_passphrase"],
  rediscover: [],
};

/**
 * How long a handed-out step may run before another bridge may take it on.
 *
 * `discover` polls the network for up to four minutes, so this has to be
 * comfortably longer than the slowest step or a session would be picked up
 * twice and the printer written to twice over.
 */
const STEP_LEASE_MS = 10 * 60 * 1000;

/** Log lines kept per session. Enough to see the whole run, bounded so a
 *  retried step cannot grow the row without limit. */
const MAX_LOG_LINES = 400;

const SESSION_COLUMNS =
  "id,org_id,state,printer_name,location,ssid,wired_ip,model,serial,firmware," +
  "wireless_mac,wireless_ip,printer_id,task_started_at,log,visible_networks";

type Session = Record<string, unknown>;

async function rpc(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${REST}/rpc/${fn}`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify(args),
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Hand the bridge its next step, if there is one.
 *
 * Returns the step plus the context it needs — including the operator's
 * secrets, which is why this runs on the server and not in the browser.
 * Returns null when the session is waiting on a person, which is most of
 * the time.
 */
export async function claimStep(
  orgId: string,
  now: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${REST}/provisioning_sessions?org_id=eq.${orgId}` +
      `&state=in.(${BRIDGE_TASKS.join(",")})` +
      `&select=${SESSION_COLUMNS}&order=created_at.asc&limit=1`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows: Session[] = await res.json();
  if (!rows.length) return null;

  const session = rows[0];
  const task = String(session.state) as BridgeTask;

  // Still running somewhere else. A step is long, so this is normal rather
  // than exceptional — the bridge polls every couple of seconds and must not
  // start `discover` four more times while the first one is still sweeping.
  const started = session.task_started_at ? Date.parse(String(session.task_started_at)) : 0;
  if (started && Date.now() - started < STEP_LEASE_MS) return null;

  // The state filter is the atomic guard, exactly as it is for a print job:
  // if the operator cancelled or another bridge got here first, zero rows
  // match and we simply return nothing.
  const claim = await fetch(
    `${REST}/provisioning_sessions?id=eq.${session.id}&org_id=eq.${orgId}&state=eq.${task}`,
    {
      method: "PATCH",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ task_started_at: now }),
    },
  );
  if (!claim.ok) return null;
  const claimed: Session[] = await claim.json();
  if (!claimed.length) return null;

  const step: Record<string, unknown> = {
    session_id: session.id,
    task,
    wired_ip: session.wired_ip ?? null,
    ssid: session.ssid ?? null,
    wireless_mac: session.wireless_mac ?? null,
  };
  if (task === "rediscover" && session.wired_ip) {
    // Sweep the network the printer was actually on, not the one the print
    // server happens to sit on. A site with a wired and a wireless range —
    // or any routed subnet — leaves the two different, and the printer is
    // then invisible to a sweep of the server's own /24 even though it is
    // perfectly reachable.
    const octets = String(session.wired_ip).split(".");
    if (octets.length === 4) step.subnet = octets.slice(0, 3).join(".");
  }
  if (task === "discover") {
    // So the sweep can tell a printer being set up from one already working,
    // and keep looking rather than stopping at the first thing that answers.
    const res = await fetch(
      `${REST}/printers?org_id=eq.${orgId}&select=printer_ip`,
      { headers: restHeaders },
    );
    step.known_ips = res.ok
      ? ((await res.json()) as { printer_ip: string | null }[])
          .map((p) => p.printer_ip)
          .filter(Boolean)
      : [];
  }
  for (const kind of SECRETS_FOR[task]) {
    const value = await rpc("provisioning_secret", { p_session: session.id, p_kind: kind });
    if (typeof value === "string" && value) step[kind] = value;
  }
  return step;
}

/**
 * Where a failed step hands the operator back to.
 *
 * It must be a state the *operator* owns, never the one that just failed: the
 * bridge polls every couple of seconds, so leaving a session sitting in a
 * bridge state would have it claimed again immediately and retried forever
 * with nobody watching. Each of these is the step where there is actually
 * something a person can do about it.
 */
const RECOVER_AT: Record<BridgeTask, string> = {
  discover: "cable",           // check the cable, the switch, the reset
  configure: "password",       // by far the likeliest cause: the wrong code
  wifi: "wifi_confirm",        // check the network name and passphrase
  rediscover: "power_cycle",   // turn it off and on again, watch the icon
};

/** Columns a bridge is allowed to write back. Anything else it sends is
 *  ignored — the bridge reports observations, it does not steer the session. */
const WRITABLE = new Set([
  "candidates",
  "wired_ip",
  "model",
  "serial",
  "firmware",
  "wireless_mac",
  "wireless_ip",
  "visible_networks",
]);

/**
 * Record what a step did and move the session on.
 *
 * A failed step hands control back to the operator at the last point where
 * they can do something about it — never back to the start of a factory reset,
 * and never left sitting in a bridge state where it would be retried forever.
 */
export async function applyResult(
  orgId: string,
  result: Record<string, unknown>,
  now: string,
): Promise<void> {
  const sessionId = result.session_id;
  if (typeof sessionId !== "string" || !sessionId) return;
  const task = String(result.task ?? "");
  if (!(BRIDGE_TASKS as readonly string[]).includes(task)) return;

  const res = await fetch(
    `${REST}/provisioning_sessions?id=eq.${sessionId}&org_id=eq.${orgId}` +
      `&select=${SESSION_COLUMNS}`,
    { headers: restHeaders },
  );
  if (!res.ok) return;
  const rows: Session[] = await res.json();
  if (!rows.length) return;                    // not this org's, or cancelled
  const session = rows[0];

  const ok = result.ok === true;
  const lines = Array.isArray(result.log) ? result.log.map(String) : [];
  const previous = Array.isArray(session.log) ? session.log : [];
  const log = [...previous, { at: now, step: task, ok, text: lines.join("\n") }]
    .slice(-MAX_LOG_LINES);

  const patch: Record<string, unknown> = { log, task_started_at: null };

  const data = (result.data ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (WRITABLE.has(key)) patch[key] = value;
  }

  if (!ok) {
    patch.error = String(result.error ?? "That step did not finish.").slice(0, 1000);
    // A step may say where its failure belongs — it knows what went wrong, and
    // "wrong password" and "setting rejected" are recovered from differently.
    const named = String(result.next_state ?? "");
    patch.state = named && named !== task ? named : RECOVER_AT[task as BridgeTask];
    await patchSession(sessionId, orgId, task, patch);
    return;
  }

  patch.error = null;
  const next = String(result.next_state ?? "");
  if (next) patch.state = next;

  // Candidates are annotated with the printer they already are, if any, so the
  // operator is never offered a working printer as though it were a new one.
  //
  // There is deliberately no shortcut past this step when only one printer
  // answers. There used to be — "a single candidate is not a choice worth
  // making anyone make" — and it wrote settings to a congregation's live
  // printer, unasked, because that printer was the only one that had finished
  // booting. Choosing which hardware gets reconfigured is exactly the choice
  // worth making someone make.
  if (next === "select") {
    patch.candidates = await annotate(orgId, (patch.candidates ?? []) as Candidate[]);
  }

  if (next === "done") {
    const printerId = await createPrinter(orgId, session, patch);
    if (printerId) patch.printer_id = printerId;
    // The passphrase has done its job. Keeping it would turn a credential the
    // operator lent us for ten minutes into one we store.
    await rpc("clear_provisioning_secrets", { p_session: sessionId });
  }

  await patchSession(sessionId, orgId, task, patch);
}

async function patchSession(
  sessionId: string,
  orgId: string,
  task: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // state=eq.<task> keeps a late report from a step the operator has already
  // cancelled or retried past from dragging the session backwards.
  await fetch(
    `${REST}/provisioning_sessions?id=eq.${sessionId}&org_id=eq.${orgId}&state=eq.${task}`,
    { method: "PATCH", headers: restHeaders, body: JSON.stringify(patch) },
  );
}

interface Candidate {
  ip?: string;
  mac?: string | null;
  model?: string | null;
  via?: string;
  /** The name of the printer this already is, if the org has it configured. */
  configured_as?: string | null;
}

/**
 * Mark any candidate that is already a printer in this organization.
 *
 * A subnet sweep finds every supported printer on the network, including the
 * ones already in service. Those are the *last* thing an operator wants to
 * reconfigure, and the easiest to pick by mistake when a freshly reset printer
 * has not finished booting.
 */
async function annotate(orgId: string, candidates: Candidate[]): Promise<Candidate[]> {
  if (!candidates.length) return candidates;
  const res = await fetch(
    `${REST}/printers?org_id=eq.${orgId}&select=name,printer_ip`,
    { headers: restHeaders },
  );
  if (!res.ok) return candidates;
  const known = new Map<string, string>();
  for (const p of (await res.json()) as { name: string; printer_ip: string | null }[]) {
    if (p.printer_ip) known.set(p.printer_ip.trim(), p.name);
  }
  return candidates.map((c) => ({
    ...c,
    configured_as: known.get(String(c.ip ?? "").trim()) ?? null,
  }));
}

/** Add the finished printer, so the operator does not have to retype what we
 *  already know. Returns its id, or null if it could not be created. */
async function createPrinter(
  orgId: string,
  session: Session,
  patch: Record<string, unknown>,
): Promise<string | null> {
  if (session.printer_id) return String(session.printer_id);   // already added
  const ip = (patch.wireless_ip ?? session.wireless_ip) as string | undefined;
  if (!ip) return null;

  const name = String(session.printer_name ?? "").trim() ||
    String(patch.model ?? session.model ?? "New Printer").replace(/^Brother\s+/i, "");

  const res = await fetch(`${REST}/printers`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      org_id: orgId,
      name,
      location: session.location ?? null,
      printer_ip: ip,
      port: 9100,
    }),
  });
  if (!res.ok) return null;
  const created = await res.json();
  return created.length ? String(created[0].id) : null;
}
