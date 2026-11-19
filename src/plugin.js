// Buzz API v1 loads a single ES module. Build inserts only the approved gateway origin.
const gateway = "__GATEWAY_ORIGIN__";
const removal = "__REVOCATION_CONFIG__";
const pluginId = "pacecar.vercel";
const type = pluginId + "/vercel";
const invitationPattern = /^[A-Za-z0-9_-]{43}$/;

export const inject = ["react", "settingsCards", "pages", "agents", "host", "communityReader", "navigation", "federatedIdentity"];

function relayOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "wss:") return "";
    return "wss://" + url.host;
  } catch { return ""; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Host stdout, exit and cancellation can arrive before the UI starts waiting.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function manualCallback() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const path = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
  return "http://127.0.0.1:61359/buzz/" + path;
}

async function listener(host, signal) {
  const ready = deferred(), received = deferred();
  let proc, buffer = "", manual = false;
  function stop(reason) {
    ready.reject(reason);
    received.reject(reason);
    if (proc) void proc.kill().catch(() => {});
  }
  const cancelled = () => stop(new Error("Sign-in was cancelled."));
  signal.throwIfAborted();
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    if (!host.spawn) throw new Error("No desktop listener");
    proc = await host.spawn("sign-in-return", {
      onStdout(chunk) {
        buffer += chunk;
        if (buffer.length > 4096) return stop(new Error("Invalid sign-in return."));
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const [kind, value, receipt] = JSON.parse(line);
            if (kind === "ready" && /^http:\/\/127\.0\.0\.1:\d+\/buzz\/[A-Za-z0-9_-]{32}$/.test(value)
              && invitationPattern.test(receipt)) ready.resolve({ callback: value, receipt });
            if (kind === "code" && /^[A-Za-z0-9_-]{1,2048}$/.test(value)) received.resolve(value);
          } catch { stop(new Error("Invalid sign-in return.")); }
        }
      },
    });
    if (signal.aborted) cancelled();
    void proc.exited.then(() => stop(new Error("Sign-in ended. Choose Connect again.")), cancelled);
    const timeout = setTimeout(() => ready.reject(new Error("Listener did not start.")), 12_000);
    try { await ready.promise; } finally { clearTimeout(timeout); }
  } catch (error) {
    if (proc) await proc.kill().catch(() => {});
    if (signal.aborted) { signal.removeEventListener("abort", cancelled); throw error; }
    manual = true;
  }
  const { callback, receipt } = manual ? { callback: manualCallback() } : await ready.promise;
  const pasted = deferred();
  const abortPaste = () => pasted.reject(new Error("Sign-in was cancelled."));
  signal.addEventListener("abort", abortPaste, { once: true });
  return {
    callback, receipt, manual, code: manual ? pasted.promise : received.promise,
    paste(value) {
      const url = new URL(value.trim());
      const code = url.searchParams.get("code");
      url.search = "";
      if (url.href !== callback || !/^[A-Za-z0-9_-]{1,2048}$/.test(code || "") ||
        new URL(value.trim()).searchParams.size !== 1) throw new Error("Use the address from this sign-in tab.");
      pasted.resolve(code);
    },
    close() {
      signal.removeEventListener("abort", cancelled);
      signal.removeEventListener("abort", abortPaste);
      abortPaste();
      stop(new Error("Sign-in closed."));
    },
  };
}

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  function VercelMark({ size = 18 }) {
    return h("span", { "aria-hidden": true, style: { display: "inline-block", width: size, height: size,
      background: "currentColor", clipPath: "polygon(50% 10%, 100% 91%, 0% 91%)" } });
  }
  const scope = () => {
    const { selected, viewer } = ctx.communityReader.snapshot();
    return { community: relayOrigin(selected), owner: viewer };
  };
  const scopeKey = () => {
    const { owner, community } = scope();
    return gateway + "|" + (owner || "") + "|" + community;
  };
  const cacheKey = () => "pacecar.vercel.profiles.v1:" + scopeKey();
  const cached = () => {
    try { return JSON.parse(localStorage.getItem(cacheKey()) || "[]"); } catch { return []; }
  };
  let model = { rows: cached(), invitation: "", expiresAt: 0, loading: false, error: "", activity: null };
  let pending, sequence = 0, lastScope = scopeKey(), alive = true;
  const subscriptions = new Set();
  function update(patch) {
    if (!alive) return;
    model = { ...model, ...patch };
    for (const listener of subscriptions) listener();
  }
  const subscribe = listener => { subscriptions.add(listener); return () => subscriptions.delete(listener); };
  const useModel = () => React.useSyncExternalStore(subscribe, () => model);
  const useRoster = () => React.useSyncExternalStore(fn => ctx.agents.subscribe(fn), () => ctx.agents.snapshot());
  const stop = () => pending?.abort();
  ctx.effect(() => {
    const off = ctx.communityReader.subscribe(() => {
      if (scopeKey() === lastScope) return;
      lastScope = scopeKey();
      sequence++;
      stop();
      update({ rows: cached(), invitation: "", expiresAt: 0, error: "", activity: null, loading: false });
    });
    return () => { alive = false; sequence++; stop(); off(); subscriptions.clear(); };
  });

  async function call(invitation, body, signal) {
    const who = scope(), before = scopeKey();
    signal?.throwIfAborted();
    if (!who.owner || !who.community) throw new Error("Select your Buzz community and open the invitation again.");
    const response = await ctx.host.request({
      url: gateway + "/api/desktop", method: "POST", timeoutMs: 45_000,
      headers: { authorization: "Bearer " + invitation, "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...who }),
    });
    signal?.throwIfAborted();
    if (!alive || scopeKey() !== before) throw new Error("The selected Buzz account or community changed.");
    const data = JSON.parse(response.body);
    if (response.status !== 200) throw new Error(data.error || "The Vercel gateway could not respond.");
    return data;
  }

  async function load(invitation) {
    if (!invitationPattern.test(invitation)) return;
    if (model.invitation !== invitation) stop();
    const read = ++sequence;
    update({ loading: true, error: "", invitation, expiresAt: 0 });
    try {
      const data = await call(invitation, { step: "list" });
      if (read !== sequence || !alive) return;
      const rows = data.agents;
      // Keep display metadata only. Proofs, sign-in codes and invitation authority stay out of local storage.
      try { localStorage.setItem(cacheKey(), JSON.stringify(rows.map(({ id, pubkey, name, picture, manageUrl }) =>
        ({ id, pubkey, name, picture, manageUrl })))); } catch {}
      update({ rows, expiresAt: data.expiresAt });
    } catch (error) {
      if (read === sequence) update({ error: error.message, invitation: "" });
    } finally {
      if (read === sequence) update({ loading: false });
    }
  }

  function chosen(id, community) {
    if (!model.invitation || model.expiresAt <= Date.now()) throw new Error("Open a fresh Vercel setup link to connect this agent.");
    if (relayOrigin(community) !== scope().community) throw new Error("Select the community from your Vercel invitation.");
    const row = model.rows.find(row => row.id === id);
    if (!row) throw new Error("Choose a connector from your Vercel invitation.");
    return row;
  }
  const openSettings = () => ctx.navigation.open({ version: 1, kind: "settings", section: pluginId + "/agents" });
  const openAgents = () => ctx.navigation.open({ version: 1, kind: "page", pluginId: "buzz.agents", pageId: "agents" });

  async function authorize(rows, signal) {
    const invite = model.invitation;
    const batch = rows.length > 1;
    const fields = batch ? { members: rows } : rows[0];
    const step = name => batch ? "batch-" + name : name;
    const label = rows.map(row => model.rows.find(item => item.id === row.id)?.name || row.id).join(", ");
    if (pending) throw new Error("Finish the current sign-in first.");
    const controller = new AbortController();
    pending = controller;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, 5 * 60_000);
    const active = controller.signal;
    let returned;
    try {
      update({ activity: { label, text: "Checking approval…" } });
      if ((await call(invite, { ...fields, step: step("approve") }, active)).approved) return;
      returned = await listener(ctx.host, active);
      const started = await call(invite, { ...fields, step: step("start"), callback: returned.callback, receipt: returned.receipt }, active);
      if (started.approved) return;
      const url = new URL(started.url);
      if (url.protocol !== "https:" || url.username || url.password || url.searchParams.get("return_to") !== returned.callback) {
        throw new Error("The identity provider returned an invalid sign-in.");
      }
      update({ activity: { label, url: url.href, manual: returned.manual, paste: returned.paste } });
      const code = await returned.code;
      active.throwIfAborted();
      update({ activity: { label, text: "Finishing approval…" } });
      const done = await call(invite, { ...fields, step: step("finish"), attempt: started.attempt, code }, active);
      if (!done.approved) throw new Error("Buzz did not confirm the approval.");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      returned?.close();
      pending = undefined;
      update({ activity: null });
    }
  }

  function button(label, onClick, disabled = false, prominent = false) {
    return h("button", { type: "button", className: "buzz-button", "data-size": "md",
      "data-variant": prominent ? "prominent" : "outline", disabled, onClick }, h("span", { className: "buzz-button-label" }, label));
  }
  function Creation({ harnessControl, onReadyChange }) {
    React.useEffect(() => { onReadyChange?.(false); }, [onReadyChange]);
    return h("div", null, harnessControl, h("p", { className: "text-body-sm text-secondary" },
      "Choose an existing Vercel agent to bring its name and portrait into Buzz."),
      button("Choose a Vercel agent", openSettings));
  }
  ctx.agents.register({
    id: "vercel", title: "Vercel", icon: VercelMark, description: "Connect an existing Vercel agent to this community.",
    defaults: () => ({ config: {} }), CreateConfiguration: Creation,
    remote: {
      async provision({ name, community, config, signal }) {
        signal.throwIfAborted();
        const row = chosen(config?.id, community);
        if (row.name !== name) throw new Error("Reopen the Vercel connector to use its current name.");
        return { pubkey: row.pubkey, ...(row.picture && { picture: row.picture }) };
      },
      async activate({ config, pubkey, community, auth, signal }) {
        const row = chosen(config?.id, community);
        if (row.pubkey !== pubkey || auth[1] !== scope().owner) throw new Error("The Buzz owner or connector changed.");
        await authorize([{ id: row.id, pubkey, proof: auth }], signal);
      },
      async profile({ pubkey, name, picture }) {
        const row = model.rows.find(row => row.pubkey === pubkey);
        if (!row || row.name !== name || (row.picture || "") !== (picture || "")) {
          throw new Error("Change this agent’s name or portrait in its Vercel connector.");
        }
      },
      async remove({ pubkey, community, signal }) {
        if (!removal || relayOrigin(community) !== scope().community) {
          throw new Error("Open the agent’s Buzz community. Its identity provider must support owner revocation.");
        }
        const session = ctx.federatedIdentity.forCommunity?.(community);
        if (!session?.apiAvailable || session.snapshot().authority?.id !== removal.authority) {
          throw new Error("Sign in to the identity provider that issued this Buzz agent.");
        }
        if (session.snapshot().status !== "signed-in") await session.signIn();
        signal.throwIfAborted();
        const result = await session.request({ path: removal.path, method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ agent_pubkey: pubkey }).toString() });
        signal.throwIfAborted();
        if (result.status !== 200 || JSON.parse(result.body).revoked !== true) {
          throw new Error("The identity provider did not confirm revocation. Retry deletion in Buzz.");
        }
        update({ rows: model.rows.filter(row => row.pubkey !== pubkey) });
        try { localStorage.setItem(cacheKey(), JSON.stringify(cached().filter(row => row.pubkey !== pubkey))); } catch {}
      },
    },
  });

  const stack = { display: "grid", gap: "0.75rem" };
  const link = (label, href) => h("a", { href, target: "_blank", rel: "noopener noreferrer", className: "text-body-sm underline" }, label);
  function Directory({ navigation, active = () => true }) {
    const state = useModel(), roster = useRoster();
    const [busy, setBusy] = React.useState("");
    const [feedback, setFeedback] = React.useState("");
    const [confirmation, setConfirmation] = React.useState("");
    const [value, setValue] = React.useState("");
    const invitation = navigation?.target?.route?.params?.invitation;
    const identity = scopeKey();
    React.useEffect(() => {
      setFeedback(""); setConfirmation(""); setValue(""); setBusy("");
      if (invitationPattern.test(invitation || "")) void load(invitation);
    }, [invitation, identity]);
    const hosted = roster.agents.filter(agent => agent.type === type && agent.owner === scope().owner && relayOrigin(agent.relay) === scope().community);
    const rows = new Map(state.rows.map(row => [row.pubkey, { ...row }]));
    for (const agent of hosted) {
      if (!rows.has(agent.pubkey)) rows.set(agent.pubkey, { pubkey: agent.pubkey, name: agent.name, picture: agent.picture });
      rows.get(agent.pubkey).native = agent;
    }
    async function connect(selected, teams = false) {
      if (!active() || pending || busy) return;
      const rows = Array.isArray(selected) ? selected : [selected];
      const before = identity;
      const fresh = rows.filter(row => !row.approved);
      setBusy(rows[0].pubkey); setFeedback(""); setConfirmation(""); setValue("");
      const controller = new AbortController();
      const valid = () => alive && scopeKey() === before && !controller.signal.aborted;
      const off = ctx.communityReader.subscribe(() => { if (scopeKey() !== before) controller.abort(); });
      try {
        if (teams || (rows.length > 1 && fresh.length)) {
          const proofs = [];
          for (const row of teams ? rows : fresh) {
            if (!valid()) return;
            const auth = await ctx.host.prepareRemoteAgentAuthorization(row.pubkey, controller.signal);
            if (auth[1] !== scope().owner) throw new Error("The Buzz identity changed. Open your invitation again.");
            proofs.push({ id: row.id, pubkey: row.pubkey, proof: auth });
          }
          if (teams) {
            await call(state.invitation, { step: "teams", members: proofs }, controller.signal);
            if (valid()) setConfirmation("Ownership approved. Open your team when the agents show Ready for teams.");
            return;
          }
          await authorize(proofs, controller.signal);
        }
        for (const row of rows) {
          if (!valid()) return;
          if (row.native?.unfinished) await ctx.agents.finish(row.pubkey);
          else await ctx.agents.create({ type, name: row.name, ...(row.picture && { picture: row.picture }), config: { id: row.id } });
        }
        if (valid()) setConfirmation(rows.length === 1 ? rows[0].name + " is in Agents. Invite it to a room to start a conversation."
          : "All " + rows.length + " selected agents are in Agents. Invite them to the rooms where you want them to work.");
      } catch (error) {
        if (valid()) setFeedback(error.name === "AbortError" ? "Sign-in was cancelled. You can connect again." : error.message);
      } finally {
        off(); controller.abort();
        if (alive && scopeKey() === before && model.invitation) await load(model.invitation);
        setBusy(""); setValue("");
      }
    }
    const visible = Array.from(rows.values());
    const current = state.activity;
    const remaining = visible.filter(row => row.id && !row.unavailable && (!row.native || row.native.unfinished));
    const disabled = Boolean(busy || current || state.loading || roster.status !== "ready");
    const bulk = remaining.length > 1 && remaining.length <= 8 && state.expiresAt > Date.now() && ctx.host.prepareRemoteAgentAuthorization;
    const repairable = visible.filter(row => row.native && !row.native.unfinished && row.teams === "needs-approval" && !row.unavailable);
    const syncing = visible.some(row => row.teams === "syncing");
    React.useEffect(() => {
      if (!syncing || !state.invitation) return;
      const timer = setInterval(() => {
        if (active() && !model.loading && !pending && model.expiresAt > Date.now()) void load(state.invitation);
      }, 5000);
      const end = setTimeout(() => clearInterval(timer), 60_000);
      return () => { clearInterval(timer); clearTimeout(end); };
    }, [syncing, state.invitation]);
    async function syncProfile(row) {
      if (!active() || disabled) return;
      setBusy(row.pubkey); setFeedback(""); setConfirmation("");
      try { await ctx.agents.save(row.native.key, { name: row.name, picture: row.picture ?? null }); }
      catch (error) { setFeedback(error.message); }
      finally { setBusy(""); }
    }
    return h("section", { style: { ...stack, gap: "1.25rem", maxWidth: "46rem", padding: "var(--space-panel-inset, 1rem)" } },
      h("header", null, h("h1", { className: "text-title", style: { margin: 0 } }, "Vercel"),
        h("p", { className: "text-body-sm text-secondary", style: { marginTop: ".45rem" } },
          visible.length ? "Connect an agent to make it available in Buzz. Invite it to the rooms where you want it to work."
          : "Open your team’s Vercel setup link to add agents to this community.")),
      state.loading && h("p", { role: "status" }, "Loading your connectors…"),
      (state.error || feedback) && h("p", { role: "alert" }, state.error || feedback),
      confirmation && h("p", { role: "status" }, confirmation),
      visible.length > 0 && h("ul", { style: { ...stack, gap: 0, listStyle: "none", padding: 0, margin: 0 } },
        visible.map(row => {
          const listed = row.native && !row.native.unfinished;
          const canConnect = row.id && state.invitation && state.expiresAt > Date.now();
          const changed = listed && canConnect && !row.unavailable &&
            (row.native.name !== row.name || (row.native.picture || "") !== (row.picture || ""));
          const status = row.retry ? "Connection unavailable · Refresh to retry"
            : listed ? (row.unavailable ? "In Agents · Check connection" : row.teams === "syncing" ? "Syncing team access…"
              : row.teams === "needs-approval" ? "In Agents · Approve to join teams" : row.teams === "ready" ? "Ready for teams"
              : row.online ? "In Agents · Online" : "In Agents")
            : row.unavailable ? "Buzz declined this grant" : !canConnect ? "Open a new setup link to connect" : row.approved ? "Approved · Ready to add" : "Needs your approval";
          return h("li", { key: row.pubkey, style: { display: "flex", gap: ".85rem", alignItems: "center", flexWrap: "wrap",
            padding: "1rem 0", borderBottom: "1px solid var(--color-border-subtle, #85858555)" } },
            row.picture ? h("img", { alt: "", src: row.picture, width: 44, height: 44, referrerPolicy: "no-referrer",
              style: { borderRadius: ".7rem", objectFit: "cover" } }) : null,
            h("div", { style: { flex: "1 1 12rem" } }, h("strong", null, row.name),
              h("div", { className: "text-body-sm text-secondary" }, status),
              row.manageUrl && link("Manage in Vercel", row.manageUrl)),
            changed && button("Update profile in Buzz", () => syncProfile(row), disabled),
            listed && canConnect && row.teams === "needs-approval" && ctx.host.prepareRemoteAgentAuthorization
              ? button("Enable teams", () => connect(row, true), disabled)
              : listed ? !changed && button("Open Agents", () => active() && openAgents())
              : button(row.approved ? "Add to Buzz" : "Connect", () => connect(row),
                Boolean(!canConnect || row.unavailable || disabled), !bulk));
        })),
      bulk &&
        h("div", null, button("Connect all " + remaining.length + " agents", () => connect(remaining), disabled, true)),
      repairable.length > 1 && repairable.length <= 8 && state.expiresAt > Date.now() && ctx.host.prepareRemoteAgentAuthorization &&
        h("div", null, button("Enable teams for all " + repairable.length + " agents", () => connect(repairable, true), disabled, true)),
      current?.url ? h("section", { "aria-label": "Buzz sign-in", style: stack },
        h("strong", null, "Finish connecting " + current.label),
        link("Continue to Buzz sign-in", current.url),
        current.manual ? h("form", { style: stack, onSubmit: event => { event.preventDefault();
          try { current.paste(value); setValue(""); setFeedback(""); } catch { setFeedback("Paste the complete return address from this sign-in."); } } },
          h("label", null, "Return address", h("input", { type: "password", autoComplete: "off", spellCheck: false, value,
            onChange: event => setValue(event.target.value), style: { display: "block", width: "100%" } })),
          h("small", null, "Automatic return is unavailable on this computer. After sign-in, paste the address from the local browser tab here."),
          h("button", { type: "submit", disabled: !value }, "Finish sign-in")) :
          h("p", { role: "status", className: "text-body-sm text-secondary" }, "Buzz will receive the sign-in automatically."),
        button("Cancel sign-in", stop)) : current?.text && h("p", { role: "status" }, current.text),
      visible.some(row => !row.native || row.native.unfinished) && h("p", { className: "text-body-sm text-secondary" },
        "Connecting authorizes each selected Buzz identity to act for you and publish under its own name. The ownership proof has no time or event-kind limit."),
      repairable.length > 0 && h("p", { className: "text-body-sm text-secondary" },
        "Enabling teams publishes your signed ownership approval on each selected agent’s Buzz profile. Buzz uses it to let you add that agent to teams."),
      state.invitation && h("div", null, button("Refresh connectors", () => active() && load(state.invitation), disabled)));
  }
  ctx.settingsCards.register({ id: "agents", title: "Vercel", icon: VercelMark, group: "Plugins", component: Directory });
  ctx.pages.register({ id: "agents", title: "Vercel agents", component: Directory, layout: "document",
    route: { version: 1, validate: params => !!params && Object.keys(params).length === 1 && invitationPattern.test(params.invitation || "") } });
}
