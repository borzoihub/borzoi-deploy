import { expect } from "chai";
import { StateStore, LostLeaseError } from "../state.js";

/**
 * Lease client (`claimCase` / `heartbeatCase` / `releaseCase`) against a mock
 * `fetch` that models the backend's atomic per-case lease contract
 * (support-agent.service.ts): claim succeeds when free/expired/self-owned, 409
 * when a live lease is held by another worker; heartbeat renews on a matching
 * token else 409; release is guarded by the token. We verify the client maps
 * 200/409/404 onto the right outcomes (acquire, skip, unsupported, LostLease).
 */

interface Row {
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null; // epoch ms
  paused: boolean;
}

const LEASE_MS = 600_000;
const NOW = 1_000_000_000_000; // fixed clock so tests are deterministic

/** A mock backend for the three lease endpoints over an in-memory `support_case`
 *  row. `supported=false` simulates an older central that 404s the routes. */
function mockBackend(row: Row | null, opts: { supported?: boolean } = {}): typeof fetch {
  const supported = opts.supported ?? true;
  let tokenSeq = 0;
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status });

  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const m = url.pathname.match(/\/cases\/(\d+)\/(claim|heartbeat|release)$/);
    if (!supported || !m) return json({}, 404);
    if (!row) return json({ message: "Case not found" }, 404);
    const action = m[2];
    const live = row.leaseExpiresAt != null && row.leaseExpiresAt > NOW;

    if (action === "claim") {
      const heldByOther = live && row.workerId !== body.workerId;
      if (heldByOther) return json({ message: "held" }, 409);
      row.workerId = body.workerId;
      row.leaseToken = `tok-${++tokenSeq}`;
      row.leaseExpiresAt = NOW + LEASE_MS;
      return json({ leaseToken: row.leaseToken, leaseSeconds: LEASE_MS / 1000 });
    }
    if (action === "heartbeat") {
      const ok = live && row.leaseToken === body.leaseToken;
      if (!ok) return json({ message: "stale" }, 409);
      row.leaseExpiresAt = NOW + LEASE_MS;
      return json({ paused: row.paused });
    }
    // release
    if (row.leaseToken === body.leaseToken) {
      row.workerId = null;
      row.leaseToken = null;
      row.leaseExpiresAt = null;
    }
    return json({ code: 200, message: "released" });
  }) as typeof fetch;
}

let originalFetch: typeof fetch;
before(() => {
  originalFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = originalFetch;
});

function storeFor(row: Row | null, opts?: { supported?: boolean }): StateStore {
  globalThis.fetch = mockBackend(row, opts);
  return new StateStore("https://central.test", "tok");
}

describe("StateStore leasing", () => {
  it("claimCase acquires a free case and returns a token", async () => {
    const row: Row = { workerId: null, leaseToken: null, leaseExpiresAt: null, paused: false };
    const res = await storeFor(row).claimCase(36, "worker-a");
    expect(res.acquired).to.equal(true);
    expect(res.leaseToken).to.be.a("string").and.not.equal(null);
    expect(row.workerId).to.equal("worker-a");
  });

  it("claimCase returns not-acquired (409) when another worker holds a live lease", async () => {
    const row: Row = {
      workerId: "worker-a",
      leaseToken: "tok-a",
      leaseExpiresAt: NOW + LEASE_MS,
      paused: false,
    };
    const res = await storeFor(row).claimCase(36, "worker-b");
    expect(res.acquired).to.equal(false);
    expect(res.leaseToken).to.equal(null);
  });

  it("claimCase acquires when the existing lease has expired", async () => {
    const row: Row = {
      workerId: "worker-a",
      leaseToken: "tok-a",
      leaseExpiresAt: NOW - 1, // expired
      paused: false,
    };
    const res = await storeFor(row).claimCase(36, "worker-b");
    expect(res.acquired).to.equal(true);
    expect(row.workerId).to.equal("worker-b");
  });

  it("claimCase re-acquires a case the SAME worker already owns", async () => {
    const row: Row = {
      workerId: "worker-a",
      leaseToken: "tok-a",
      leaseExpiresAt: NOW + LEASE_MS,
      paused: false,
    };
    const res = await storeFor(row).claimCase(36, "worker-a");
    expect(res.acquired).to.equal(true);
  });

  it("claimCase treats an unsupported route (404) as acquired-unclaimed (proceed)", async () => {
    const res = await storeFor(null, { supported: false }).claimCase(36, "worker-a");
    expect(res.acquired).to.equal(true);
    expect(res.leaseToken).to.equal(null);
  });

  it("heartbeatCase renews and returns the pause flag on a matching token", async () => {
    const row: Row = {
      workerId: "worker-a",
      leaseToken: "tok-a",
      leaseExpiresAt: NOW + 1,
      paused: true,
    };
    const res = await storeFor(row).heartbeatCase(36, "tok-a");
    expect(res.paused).to.equal(true);
    expect(row.leaseExpiresAt).to.equal(NOW + LEASE_MS); // renewed
  });

  it("heartbeatCase throws LostLeaseError on a stale token (409)", async () => {
    const row: Row = {
      workerId: "worker-b",
      leaseToken: "tok-b",
      leaseExpiresAt: NOW + LEASE_MS,
      paused: false,
    };
    let threw: unknown;
    try {
      await storeFor(row).heartbeatCase(36, "tok-a-stale");
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.instanceOf(LostLeaseError);
  });

  it("releaseCase clears a lease it owns and never throws on a mismatch", async () => {
    const row: Row = {
      workerId: "worker-a",
      leaseToken: "tok-a",
      leaseExpiresAt: NOW + LEASE_MS,
      paused: false,
    };
    const store = storeFor(row);
    await store.releaseCase(36, "tok-a");
    expect(row.leaseToken).to.equal(null);
    // A stale release is a best-effort no-op (must not throw).
    await store.releaseCase(36, "tok-a");
  });
});
