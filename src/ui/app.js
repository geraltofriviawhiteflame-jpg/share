/*
 * Share — mobile web client.
 *
 * Dependency-free on purpose: the API is the source of truth and this file is
 * only an HTTP client plus a renderer. Screens are produced from one state
 * object, so a reload after a failed mutation always shows real server data.
 * Money is integer paise everywhere except inside the ₹ input fields.
 */
(() => {
  "use strict";

  const app = document.getElementById("app");
  const sheetRoot = document.getElementById("sheet-root");
  const toastEl = document.getElementById("toast");
  const networkEl = document.getElementById("network");

  const CATEGORIES = [
    { id: "food", label: "Meals", glyph: "🍽️" },
    { id: "groceries", label: "Groceries", glyph: "🛒" },
    { id: "travel", label: "Travel", glyph: "🚗" },
    { id: "stay", label: "Stay", glyph: "🏨" },
    { id: "drinks", label: "Drinks", glyph: "🥤" },
    { id: "bills", label: "Bills", glyph: "🧾" },
    { id: "fun", label: "Fun", glyph: "🎉" },
    { id: "other", label: "Other", glyph: "💸" },
  ];
  const METHODS = [
    { id: "upi", label: "UPI" },
    { id: "cash", label: "Cash" },
    { id: "bank_transfer", label: "Bank" },
    { id: "other", label: "Other" },
  ];
  const TABS = [
    { id: "balances", label: "Balances", glyph: "⚖️" },
    { id: "activity", label: "Activity", glyph: "🧾" },
    { id: "people", label: "People", glyph: "👥" },
  ];
  const PAGE_SIZE = 100;
  const SESSION_KEY = "share.session.v1";
  const GROUP_KEY = "share.lastGroup.v1";

  // ---------------------------------------------------------------- helpers

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);

  const rupee = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const money = (paise) => rupee.format(Number(paise || 0) / 100);
  const absMoney = (paise) => money(Math.abs(Number(paise || 0)));

  /** Text field (₹, at most two decimals) -> integer paise, or null. */
  function toPaise(raw) {
    const text = String(raw ?? "").trim().replace(/[,\s₹]/g, "");
    if (text === "" || !/^\d{1,12}(\.\d{1,2})?$/.test(text)) return null;
    const paise = Math.round(Number(text) * 100);
    return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
  }
  const paiseToInput = (paise) =>
    paise === null || paise === undefined || paise === "" ? "" : (Number(paise) / 100).toFixed(2);

  const todayISO = () => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  };
  const dayLabel = (iso) => {
    const date = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(date.valueOf())) return iso;
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  };
  const monthLabel = (iso) => {
    const date = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(date.valueOf())) return iso;
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  };

  const initials = (name) =>
    String(name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();

  const avatarTone = (seed) => {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    return `avatar-${hash % 7}`;
  };
  const avatar = (name, seed, size) =>
    `<span class="avatar ${avatarTone(String(seed))}${size ? ` ${size}` : ""}" aria-hidden="true">${esc(
      initials(name),
    )}</span>`;

  const netClass = (paise) => (paise > 0 ? "pos" : paise < 0 ? "neg" : "");
  const slug = (value) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "") || "person";

  const store = {
    get(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode: the app still works, it just forgets on reload */
      }
    },
    clear(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };

  let toastTimer = 0;
  function toast(message, bad) {
    toastEl.textContent = message;
    toastEl.classList.toggle("bad", Boolean(bad));
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), bad ? 4200 : 2400);
  }

  /** One place that knows about JSON, error messages, and the offline banner. */
  async function api(path, { method = "GET", body, query } = {}) {
    const url = new URL(path, window.location.origin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      networkEl.hidden = false;
      throw new Error("Cannot reach the Share API from this device.");
    }
    networkEl.hidden = true;

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const message =
        payload && typeof payload.message === "string" ? payload.message : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  // ----------------------------------------------------------------- state

  const state = {
    user: null,
    users: [],
    groups: [],
    groupOutstanding: new Map(),
    group: null,
    roster: [],
    expenses: [],
    settlements: [],
    balances: null,
    tab: "balances",
    loading: false,
    busy: false,
    error: null,
    sheet: null,
    mainDraft: {},
    onboardingCreate: false,
    loadedGroup: "",
  };

  const route = () => {
    const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "onboarding") return { name: "onboarding" };
    if (parts[0] === "g" && parts[1]) {
      return { name: "group", groupId: parts[1], tab: TABS.some((t) => t.id === parts[2]) ? parts[2] : "balances" };
    }
    return { name: "groups" };
  };
  const go = (hash) => {
    if (window.location.hash === hash) render();
    else window.location.hash = hash;
  };

  const myMemberId = () => state.group?.member_id || "";
  const isMe = (memberId) => Boolean(memberId) && memberId === myMemberId();
  const activeMembers = () => state.roster.filter((member) => member.status === "active");
  const balanceOf = (memberId) =>
    state.balances?.balances.find((item) => item.member_id === memberId)?.balance_paise ?? 0;
  const memberName = (memberId) => {
    const member = state.roster.find((item) => item.member_id === memberId);
    if (member) return member.display_name;
    const balance = state.balances?.balances.find((item) => item.member_id === memberId);
    return balance ? balance.display_name : `${String(memberId).slice(0, 8)}…`;
  };
  const findExpense = (id) => state.expenses.find((expense) => expense.id === id);
  const findSettlement = (id) => state.settlements.find((settlement) => settlement.id === id);
  const roleLabel = (role) => ({ owner: "Owner", admin: "Admin", member: "Member" }[role] || "Member");

  // ------------------------------------------------------------ data loading

  let groupRequest = 0;

  async function boot() {
    state.loading = true;
    render();
    try {
      state.users = (await api("/v1/users")) || [];
    } catch (error) {
      state.error = error.message;
      state.loading = false;
      render();
      return;
    }
    const session = store.get(SESSION_KEY);
    const known = session?.userId ? state.users.find((user) => user.id === session.userId) : null;
    if (known) {
      adoptUser(known);
      await loadGroups();
    }
    state.loading = false;
    render();
  }

  const adoptUser = (user) => {
    state.user = { id: user.id, email: user.email, display_name: user.display_name };
  };

  async function loadGroups() {
    if (!state.user) return;
    state.loading = true;
    render();
    try {
      state.groups = (await api("/v1/groups", { query: { user_id: state.user.id } })) || [];
      await loadGroupOutstanding();
      state.error = null;
    } catch (error) {
      state.error = error.message;
    }
    state.loading = false;
    render();
  }

  /** One balances call per group powers "you owe / you are owed" on the list. */
  async function loadGroupOutstanding() {
    const results = await Promise.all(
      state.groups.slice(0, 12).map(async (group) => {
        try {
          const balances = await api(`/v1/groups/${group.group_id}/balances`);
          const mine = balances.balances.find((item) => item.member_id === group.member_id);
          return [group.group_id, { balancePaise: mine?.balance_paise ?? 0, people: balances.balances.length }];
        } catch {
          return null;
        }
      }),
    );
    state.groupOutstanding = new Map(results.filter(Boolean));
  }

  async function openGroup(groupId) {
    if (!state.user) return;
    if (!state.groups.some((group) => group.group_id === groupId)) {
      try {
        state.groups = (await api("/v1/groups", { query: { user_id: state.user.id } })) || [];
      } catch (error) {
        state.error = error.message;
        render();
        return;
      }
    }
    const group = state.groups.find((item) => item.group_id === groupId);
    if (!group) {
      state.error = "You are not a member of that group.";
      state.group = null;
      state.loadedGroup = "";
      go("#/");
      return;
    }
    state.group = group;
    state.tab = route().tab;
    store.set(GROUP_KEY, { userId: state.user.id, groupId });
    await loadGroup();
  }

  async function loadGroup() {
    if (!state.group) return;
    const requestId = (groupRequest += 1);
    const groupId = state.group.group_id;
    state.loading = true;
    render();
    try {
      const [roster, balances, expenses, settlements] = await Promise.all([
        api(`/v1/groups/${groupId}/members`),
        api(`/v1/groups/${groupId}/balances`),
        api(`/v1/groups/${groupId}/expenses`, { query: { limit: PAGE_SIZE } }),
        api(`/v1/groups/${groupId}/settlements`, { query: { limit: PAGE_SIZE } }),
      ]);
      if (requestId !== groupRequest) return;
      state.roster = roster || [];
      state.balances = balances;
      state.expenses = expenses || [];
      state.settlements = settlements || [];
      state.loadedGroup = groupId;
      state.error = null;
    } catch (error) {
      if (requestId !== groupRequest) return;
      state.roster = [];
      state.balances = null;
      state.expenses = [];
      state.settlements = [];
      state.loadedGroup = "";
      state.error = error.message;
    }
    if (requestId !== groupRequest) return;
    state.loading = false;
    render();
    void loadGroupOutstanding().then(() => {
      if (requestId === groupRequest) render();
    });
  }

  /**
   * Runs a write, disables controls while it is in flight, surfaces the API's
   * message on failure, then reloads whatever the write can affect.
   */
  async function mutate(action, after = "group") {
    if (state.busy) return false;
    state.busy = true;
    renderSheet();
    try {
      await action();
      state.error = null;
      closeSheet();
      if (after === "group") await loadGroup();
      else if (after === "groups") await loadGroups();
      state.busy = false;
      renderSheet();
      render();
      return true;
    } catch (error) {
      state.busy = false;
      renderSheet();
      state.error = error.message;
      toast(error.message, true);
      render();
      return false;
    }
  }

  // ---------------------------------------------------------------- render

  function render() {
    const current = route();
    if (!state.user) {
      app.classList.add("no-nav");
      app.innerHTML = [onboardingAppbar(), state.error ? errorBanner() : "", onboardingView()].join("");
      return;
    }
    if (current.name === "group" && state.group?.group_id === current.groupId && state.loadedGroup === current.groupId) {
      app.classList.remove("no-nav");
      app.innerHTML = [
        groupAppbar(),
        errorBanner(),
        groupView(current.tab),
        navBar(),
        fab(),
      ].join("");
      return;
    }
    app.classList.add("no-nav");
    app.innerHTML = [groupsAppbar(), errorBanner(), groupsView()].join("");
  }

  const errorBanner = () =>
    state.error
      ? `<div class="banner" role="alert">${esc(state.error)}
            <button class="banner-x" type="button" data-act="dismiss-error">dismiss</button>
          </div>`
      : "";

  const spinner = () => (state.loading ? '<span class="spinner" aria-label="Loading"></span>' : "");

  const meCard = () =>
    `<button class="me-card" type="button" data-act="switch-person">
       ${avatar(state.user.display_name, state.user.id)}
       <span>${esc(state.user.display_name)}</span>
     </button>`;

  function groupsAppbar() {
    return `<header class="appbar">
      <div class="appbar-titles"><h1>Share</h1><p>${state.groups.length} ${
        state.groups.length === 1 ? "group" : "groups"
      } · ${spinner()}</p></div>
      ${meCard()}
      <button class="icon-button" type="button" data-act="new-group" aria-label="New group">＋</button>
    </header>`;
  }

  function groupAppbar() {
    return `<header class="appbar">
      <button class="icon-button" type="button" data-act="back" aria-label="Back to groups">‹</button>
      <div class="appbar-titles">
        <h1>${esc(state.group.name)}</h1>
        <p>${roleLabel(state.group.role)} · ${activeMembers().length} active · ${spinner()}</p>
      </div>
      <button class="icon-button" type="button" data-act="refresh" aria-label="Refresh">↻</button>
    </header>`;
  }

  const loadingCard = (message) =>
    `<div class="card pad"><div class="center stack">${spinner()}<p class="muted small">${esc(message)}</p></div></div>`;

  // ---- onboarding ----

  function onboardingAppbar() {
    return `<header class="appbar">
      <div class="appbar-titles"><h1>Share</h1><p>Split expenses, keep the maths honest.</p></div>
    </header>`;
  }

  function onboardingView() {
    const picking = state.users.length > 0 && !state.onboardingCreate;
    return `<div class="content">
      ${
        picking
          ? `<p class="eyebrow">Who is using this phone?</p>
             <div class="card">${state.users
               .map(
                 (person) => `<button class="row row-button" type="button" data-act="sign-in" data-user-id="${esc(person.id)}">
                   ${avatar(person.display_name, person.id, "lg")}
                   <span class="row-main">
                     <span class="row-title">${esc(person.display_name)}</span>
                     <span class="row-sub">${esc(person.email)}</span>
                   </span>
                   <span class="tag accent">continue</span>
                 </button>`,
               )
               .join("")}</div>
             <button class="btn block" type="button" data-act="create-person">Add another person</button>`
          : `<p class="eyebrow">New here</p>`
      }
      <form class="card pad stack" data-form="person">
        <h2 class="sheet-title">${picking ? "Create a person" : "Name your person"}</h2>
        <p class="field"><label for="p-name">Name</label>
          <input id="p-name" type="text" data-field="display_name" placeholder="Anil" autocomplete="name" value="${esc(
            state.mainDraft.display_name || "",
          )}" /></p>
        <p class="field"><label for="p-email">Email (a label, for now)</label>
          <input id="p-email" type="email" data-field="email" placeholder="anil@example.com" autocomplete="email" inputmode="email" value="${esc(
            state.mainDraft.email || "",
          )}" /></p>
        <button class="btn primary block" type="submit">${picking ? "Create and use" : "Create and start"}</button>
        ${picking ? '<button class="btn block" type="button" data-act="pick-person">Back to the list</button>' : ""}
      </form>
      <p class="hint">There is no sign-in yet, so this device remembers your choice and the API trusts it. Emails are only labels until authentication lands — that is the deliberate next milestone of this project.</p>
    </div>`;
  }

  // ---- groups list ----

  function groupsView() {
    const groups = state.groups;
    const net = groups.reduce((sum, group) => sum + (state.groupOutstanding.get(group.group_id)?.balancePaise ?? 0), 0);
    return `<div class="content">
      <div class="stats">
        <div class="stat"><span>Groups</span><b>${groups.length}</b></div>
        <div class="stat"><span>Net across groups</span><b class="${netClass(net)}">${money(net)}</b></div>
      </div>
      ${
        state.loading && !groups.length
          ? loadingCard("Loading your groups…")
          : groups.length
            ? `<p class="eyebrow">Groups</p>
               <div class="stack">${groups.map(groupCard).join("")}
                 <button class="btn block" type="button" data-act="new-group">＋ New group</button>
               </div>`
            : `<div class="card empty">
                 <span class="glyph" aria-hidden="true">🧾</span>
                 <h2>No groups yet</h2>
                 <p>A group owns its expenses and balances. Create one for a trip, a flat, or a weekend.</p>
                 <button class="btn primary" type="button" data-act="new-group">Create your first group</button>
               </div>`
      }
    </div>`;
  }

  function groupCard(group) {
    const entry = state.groupOutstanding.get(group.group_id);
    const balance = entry?.balancePaise ?? 0;
    const status = !entry
      ? "Balances not loaded yet"
      : balance === 0
        ? "Settled up"
        : balance > 0
          ? `<span class="pos">You are owed ${absMoney(balance)}</span>`
          : `<span class="neg">You owe ${absMoney(balance)}</span>`;
    return `<button class="group-card" type="button" data-act="open-group" data-group-id="${esc(group.group_id)}">
      <span class="group-card-top">
        <h2>${esc(group.name)}</h2>
        <span class="tag">${esc(group.role)}</span>
      </span>
      <p class="group-card-meta">${status}</p>
      <p class="group-card-meta small">${entry ? `${entry.people} people · ` : ""}tap to open</p>
    </button>`;
  }

  // ---- group tabs ----

  function navBar() {
    return `<nav class="nav" aria-label="Group sections">${TABS.map(
      (tab) => `<button type="button" class="${state.tab === tab.id ? "on" : ""}"
        data-act="tab" data-tab="${tab.id}" aria-current="${state.tab === tab.id}">
        <span class="glyph" aria-hidden="true">${tab.glyph}</span>${tab.label}</button>`,
    ).join("")}</nav>`;
  }

  function fab() {
    return state.tab === "people"
      ? `<button class="fab" type="button" data-act="add-person">＋<span>Add person</span></button>`
      : `<button class="fab" type="button" data-act="add-expense">＋<span>Expense</span></button>`;
  }

  function groupView(tab) {
    if (state.loading && state.loadedGroup !== state.group.group_id) {
      return `<div class="content">${loadingCard(`Loading ${state.group.name}…`)}</div>`;
    }
    if (tab === "activity") return activityView();
    if (tab === "people") return peopleView();
    return balancesView();
  }

  function balancesView() {
    const myBalance = balanceOf(myMemberId());
    const spend = state.expenses.reduce((sum, expense) => sum + expense.amount_paise, 0);
    const transfers = state.balances?.suggested_transfers || [];
    const rows = [...(state.balances?.balances || [])].sort(
      (left, right) => Math.abs(right.balance_paise) - Math.abs(left.balance_paise),
    );
    const truncated = state.expenses.length >= PAGE_SIZE;

    return `<div class="content">
      <section class="hero ${myBalance < 0 ? "owe" : ""}">
        <p>${myBalance === 0 ? "You are settled up" : myBalance > 0 ? "You are owed" : "You owe"}</p>
        <strong>${absMoney(myBalance)}</strong>
        <p class="hero-foot">${
          myBalance === 0
            ? "Nothing to pay anyone in this group right now."
            : myBalance > 0
              ? "Record it here when the money actually arrives."
              : "Settle it below; the balance re-derives immediately."
        }</p>
      </section>
      <div class="stats">
        <div class="stat"><span>Group spend${truncated ? " (latest)" : ""}</span><b>${money(spend)}</b></div>
        <div class="stat"><span>Expenses</span><b>${state.expenses.length}</b></div>
        <div class="stat"><span>Settled</span><b>${state.settlements.length}</b></div>
      </div>

      <div class="section-head"><h3>To settle</h3><span class="rule"></span></div>
      ${
        transfers.length
          ? `<div class="card">${transfers
              .map(
                (transfer, index) => `<div class="row">
                  <span class="row-main">
                    <p class="row-title">${esc(memberName(transfer.from_member_id))} <span class="muted">→</span> ${esc(
                      memberName(transfer.to_member_id),
                    )}</p>
                    <p class="row-sub">${
                      isMe(transfer.from_member_id)
                        ? "you pay"
                        : isMe(transfer.to_member_id)
                          ? "you receive"
                          : "between two others"
                    } · smallest transfer that clears a pair</p>
                  </span>
                  <span class="row-amount ${isMe(transfer.from_member_id) ? "neg" : "pos"}">${money(transfer.amount_paise)}</span>
                  <button class="btn" type="button" data-act="record-transfer" data-index="${index}">Record</button>
                </div>`,
              )
              .join("")}</div>`
          : rows.length
            ? `<div class="card pad"><p class="center muted small">Nobody owes anybody. The next expense starts a fresh round.</p></div>`
            : `<div class="card pad"><p class="center muted small">Add people to this group to start splitting.</p></div>`
      }
      <p class="hint">Suggestions are a greedy match over integer paise. They are not stored records — the ledger is.</p>
      <button class="btn block" type="button" data-act="settle-up">Record a settlement between any two people</button>

      <div class="section-head"><h3>Everyone</h3><span class="rule"></span></div>
      ${
        rows.length
          ? `<div class="card">${rows
              .map(
                (row) => `<div class="row">
                  ${avatar(row.display_name, row.member_id)}
                  <span class="row-main">
                    <p class="row-title">${esc(row.display_name)}${
                      isMe(row.member_id) ? ' <span class="tag accent">you</span>' : ""
                    }${row.status !== "active" ? ' <span class="tag">left</span>' : ""}</p>
                    <p class="row-sub">${
                      row.balance_paise > 0 ? "is owed" : row.balance_paise < 0 ? "owes the group" : "settled up"
                    }</p>
                  </span>
                  <span class="row-amount ${netClass(row.balance_paise)}">${
                    row.balance_paise === 0 ? "₹0.00" : money(row.balance_paise)
                  }</span>
                </div>`,
              )
              .join("")}</div>`
          : `<div class="card empty">
               <h2>No balances yet</h2>
               <p>Add the first expense and everyone in the group gets a share.</p>
               <button class="btn primary" type="button" data-act="add-expense">Add an expense</button>
             </div>`
      }
    </div>`;
  }

  function activityView() {
    if (!state.expenses.length && !state.settlements.length) {
      return `<div class="content"><div class="card empty">
        <span class="glyph" aria-hidden="true">🪄</span>
        <h2>Nothing recorded yet</h2>
        <p>Expenses are split into share rows when they are written, so this list never has to be recomputed later.</p>
        <button class="btn primary" type="button" data-act="add-expense">Add an expense</button>
      </div></div>`;
    }

    const entries = [
      ...state.expenses.map((expense) => ({
        kind: "expense",
        id: expense.id,
        date: expense.expense_date,
        title: expense.description,
        glyph: categoryGlyph(expense.category),
        amount: expense.amount_paise,
      })),
      ...state.settlements.map((settlement) => ({
        kind: "settlement",
        id: settlement.id,
        date: settlement.settlement_date,
        title: settlementTitle(settlement),
        glyph: settlement.payment_method === "cash" ? "💵" : "💳",
        amount: settlement.amount_paise,
      })),
    ].sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0));

    let lastMonth = "";
    const rows = entries
      .map((entry) => {
        const month = monthLabel(entry.date);
        const header =
          month === lastMonth
            ? ""
            : `<div class="section-head"><h3>${esc(month)}</h3><span class="rule"></span></div>`;
        lastMonth = month;
        const sub =
          entry.kind === "expense" ? expenseSubtitle(entry.id) : settlementSubtitle(entry.id);
        const open = entry.kind === "expense" ? `data-act="expense-detail" data-id="${esc(entry.id)}"` : "";
        return `${header}<button class="row row-button" type="button" ${open}>
          <span class="expense-icon" aria-hidden="true">${entry.glyph}</span>
          <span class="row-main">
            <span class="row-title">${esc(entry.title)}</span>
            <span class="row-sub">${esc(dayLabel(entry.date))} · ${esc(sub)}</span>
          </span>
          <span class="row-amount ${entry.kind === "settlement" ? "muted" : ""}">${money(entry.amount)}</span>
        </button>`;
      })
      .join("");

    return `<div class="content">
      <p class="hint">${entries.length} record${entries.length === 1 ? "" : "s"} loaded · the API page size is ${PAGE_SIZE}.</p>
      <div class="card">${rows}</div>
    </div>`;
  }

  function peopleView() {
    const canManage = ["owner", "admin"].includes(state.group.role);
    const owner = state.roster.find((member) => member.role === "owner");
    const balanceRows = new Map((state.balances?.balances || []).map((row) => [row.member_id, row]));
    return `<div class="content">
      ${
        canManage
          ? ""
          : `<p class="hint">Only an owner or admin can add people here. Ask ${esc(
              owner?.display_name || "the owner",
            )}.</p>`
      }
      <p class="eyebrow">In this group</p>
      <div class="card">${state.roster
        .map((member) => {
          const balance = balanceRows.get(member.member_id);
          return `<div class="row">
            ${avatar(member.display_name, member.member_id)}
            <span class="row-main">
              <p class="row-title">${esc(member.display_name)}${
                isMe(member.member_id) ? ' <span class="tag accent">you</span>' : ""
              }${member.status !== "active" ? ' <span class="tag">left</span>' : ""}</p>
              <p class="row-sub">${esc(member.role)} · ${
                balance
                  ? balance.balance_paise === 0
                    ? "settled up"
                    : `${balance.balance_paise > 0 ? "is owed " : "owes "}${absMoney(balance.balance_paise)}`
                  : "no balance yet"
              }</p>
            </span>
            ${balance ? `<span class="row-amount ${netClass(balance.balance_paise)}">${money(balance.balance_paise)}</span>` : ""}
          </div>`;
        })
        .join("")}</div>
      <div class="section-head"><h3>Group</h3><span class="rule"></span></div>
      <div class="card pad stack">
        <div class="check-row">
          <span class="row-main"><span class="row-title">Simplify debts</span>
            <span class="row-sub">${
              state.group.simplify_debts
                ? "on since this group was created"
                : "off — balances are shown per pair"
            }</span></span>
          <span class="tag ${state.group.simplify_debts ? "accent" : ""}">${
            state.group.simplify_debts ? "on" : "off"
          }</span>
        </div>
        <p class="hint">The API has no session yet, so it acts on IDs: group <code>${esc(
          state.group.group_id,
        )}</code>, your membership <code>${esc(state.group.member_id)}</code>. This app sends them as the actor on every write.</p>
        <button class="btn block" type="button" data-act="add-person">Add a person</button>
      </div>
    </div>`;
  }

  const categoryGlyph = (category) => CATEGORIES.find((item) => item.id === category)?.glyph || "💸";
  const categoryLabel = (category) => CATEGORIES.find((item) => item.id === category)?.label || "General";

  function expenseSubtitle(id) {
    const expense = findExpense(id);
    if (!expense) return "";
    const paidBy = isMe(expense.payer.member_id) ? "you paid" : `${memberName(expense.payer.member_id)} paid`;
    return `${paidBy} · split ${expense.shares.length} ${expense.split_method === "equal" ? "ways equally" : "by exact amounts"}`;
  }
  function settlementTitle(settlement) {
    const payer = isMe(settlement.paid_by_member_id) ? "You" : memberName(settlement.paid_by_member_id);
    const payee = isMe(settlement.received_by_member_id) ? "you" : memberName(settlement.received_by_member_id);
    return `${payer} paid ${payee}`;
  }
  function settlementSubtitle(id) {
    const settlement = findSettlement(id);
    if (!settlement) return "";
    const method = METHODS.find((item) => item.id === settlement.payment_method)?.label || "Transfer";
    return `settlement · ${method.toLowerCase()}`;
  }

  // ---------------------------------------------------------------- sheets

  function openSheet(sheet) {
    state.sheet = { draft: {}, fresh: true, ...sheet };
    renderSheet();
  }

  function closeSheet() {
    state.sheet = null;
    renderSheet();
  }

  /** Sheets render from their draft, so a chip tap never loses typed input. */
  function renderSheet() {
    if (!state.sheet) {
      sheetRoot.innerHTML = "";
      return;
    }
    const previous = sheetRoot.querySelector(".sheet-body");
    const scrollTop = previous ? previous.scrollTop : 0;
    sheetRoot.innerHTML = sheetView(state.sheet);
    const next = sheetRoot.querySelector(".sheet-body");
    if (next) next.scrollTop = scrollTop;
    if (state.sheet.fresh) {
      const target = sheetRoot.querySelector("[data-autofocus]");
      if (target) target.focus();
      state.sheet.fresh = false;
    }
  }

  const sheetView = (sheet) => {
    const views = {
      group: groupSheet,
      expense: expenseSheet,
      settlement: settlementSheet,
      person: personSheet,
      switch: switchSheet,
      detail: detailSheet,
    };
    return `<div class="sheet-backdrop" data-act="close-sheet"></div>${(views[sheet.kind] || (() => ""))(sheet)}`;
  };

  const sheetHead = (title, subtitle) =>
    `<div class="grab"></div><header class="sheet-head"><div class="appbar-titles">
       <h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
     </div><button class="icon-button" type="button" data-act="close-sheet" aria-label="Close">✕</button></header>`;

  const submitLabel = (text) => (state.busy ? '<span class="spinner" aria-hidden="true"></span> Saving' : esc(text));

  const chips = (items, selectedId, act, extra = "") =>
    `<span class="chips">${items
      .map(
        (item) => `<button class="chip ${selectedId === item.id ? "on" : ""}" type="button"
          data-act="${act}" ${extra} data-value="${esc(item.id)}"${item.disabled ? " disabled" : ""}>${item.label}</button>`,
      )
      .join("")}</span>`;

  function groupSheet() {
    const draft = state.sheet.draft;
    return `<section class="sheet" role="dialog" aria-modal="true" aria-label="New group">
      ${sheetHead("New group", "A group owns its expenses, members, and balances")}
      <form class="sheet-body" data-form="group">
        <p class="field"><label for="g-name">Name</label>
          <input id="g-name" type="text" data-field="name" data-autofocus placeholder="Goa trip" value="${esc(draft.name || "")}" /></p>
        <p class="field"><label for="g-desc">Description (optional)</label>
          <input id="g-desc" type="text" data-field="description" placeholder="Stays, food, scooter" value="${esc(draft.description || "")}" /></p>
        <label class="check-row" for="g-simplify">
          <span class="row-main"><span class="row-title">Simplify debts</span>
            <span class="row-sub">fewer transfers between people, same amounts</span></span>
          <input id="g-simplify" type="checkbox" data-field="simplify_debts" ${draft.simplify_debts === false ? "" : "checked"} />
        </label>
        <p class="hint">You become the owner and the first member in the same transaction.</p>
      </form>
      <footer class="sheet-foot"><button class="btn primary block" type="button" data-act="create-group" ${
        state.busy ? "disabled" : ""
      }>${submitLabel("Create group")}</button></footer>
    </section>`;
  }

  /** @returns the live "here is what will be stored" line for the expense sheet */
  function expenseSummary(draft) {
    const amountPaise = toPaise(draft.amount);
    const members = activeMembers();
    const split = draft.split || "equal";
    if (amountPaise === null) {
      return { text: "Enter an amount in rupees, up to two decimals.", bad: true };
    }
    if (split === "equal") {
      const participants = draft.participants || [];
      if (!participants.length) return { text: "Pick at least one person to split with.", bad: true };
      if (amountPaise < participants.length) {
        return { text: `₹0.01 each needs ${participants.length} paise or more.`, bad: true };
      }
      const base = Math.floor(amountPaise / participants.length);
      const remainder = amountPaise % participants.length;
      return {
        text: `${money(base)} each for ${participants.length} ${participants.length === 1 ? "person" : "people"}${
          remainder ? ` · ${remainder} pay ${money(base + 1)} (rounding paise)` : " · no rounding left"
        }`,
        bad: false,
      };
    }
    const shares = exactShares(draft, members);
    const total = shares.reduce((sum, share) => sum + share.owed_paise, 0);
    if (!shares.length) return { text: "Enter what each person owes, or tap Fill equally.", bad: true };
    if (total === amountPaise) return { text: `${money(total)} across ${shares.length} people · balanced ✓`, bad: false };
    return {
      text: `${money(total)} allocated of ${money(amountPaise)} · ${
        total < amountPaise ? `${money(amountPaise - total)} left to split` : `${money(total - amountPaise)} too much`
      }`,
      bad: true,
    };
  }

  function exactShares(draft, members) {
    const shares = [];
    for (const member of members) {
      const paise = toPaise((draft.exact || {})[member.member_id]);
      if (paise) shares.push({ member_id: member.member_id, owed_paise: paise });
    }
    return shares;
  }

  function expenseValid(draft) {
    const amountPaise = toPaise(draft.amount);
    const members = activeMembers();
    const split = draft.split || "equal";
    if (amountPaise === null) return false;
    if (!String(draft.description || "").trim()) return false;
    if (!draft.payer || !draft.date) return false;
    if (split === "equal") {
      const participants = draft.participants || [];
      return participants.length > 0 && amountPaise >= participants.length;
    }
    const shares = exactShares(draft, members);
    return shares.length > 0 && shares.reduce((sum, share) => sum + share.owed_paise, 0) === amountPaise;
  }

  function expenseSheet() {
    const draft = state.sheet.draft;
    const members = activeMembers();
    const split = draft.split || "equal";
    const participants = draft.participants || [];
    const summary = expenseSummary(draft);

    const memberChips = (selectedIds, act, single) =>
      `<span class="chips">${members
        .map(
          (member) => `<button class="chip ${single ? "payer" : ""} ${
            selectedIds.includes(member.member_id) ? "on" : ""
          }" type="button" data-act="${act}" data-value="${esc(member.member_id)}">${esc(member.display_name)}${
            isMe(member.member_id) ? " (you)" : ""
          }</button>`,
        )
        .join("")}</span>`;

    const exactRows = members
      .map(
        (member) => `<div class="row">
          ${avatar(member.display_name, member.member_id, "sm")}
          <span class="row-main row-title">${esc(member.display_name)}${isMe(member.member_id) ? " (you)" : ""}</span>
          <input type="text" inputmode="decimal" aria-label="${esc(member.display_name)} owes"
            data-field="amount:${esc(member.member_id)}" placeholder="0.00"
            value="${esc((draft.exact || {})[member.member_id] ?? "")}" /></div>`,
      )
      .join("");

    return `<section class="sheet" role="dialog" aria-modal="true" aria-label="Add expense">
      ${sheetHead("Add expense", state.group.name)}
      <form class="sheet-body" data-form="expense">
        <p class="field"><label for="e-desc">What was it?</label>
          <input id="e-desc" type="text" data-field="description" data-autofocus placeholder="Dinner at Vege Restaurant" value="${esc(
            draft.description || "",
          )}" /></p>
        <div class="split-two">
          <p class="field"><label for="e-amount">Amount</label>
            <span class="money"><span>₹</span>
              <input id="e-amount" type="text" inputmode="decimal" autocomplete="off" data-field="amount" placeholder="0.00" value="${esc(
                draft.amount || "",
              )}" /></span></p>
          <p class="field"><label for="e-date">Date</label>
            <input id="e-date" type="date" data-field="date" value="${esc(draft.date || todayISO())}" /></p>
        </div>
        <p class="field"><span class="field-label">Category</span>
          ${chips(CATEGORIES, draft.category, "pick-category")}</p>
        <p class="field"><span class="field-label">Paid by</span>
          ${memberChips([draft.payer], "pick-payer", true)}</p>
        <p class="field"><span class="field-label">Split</span>
          <span class="segment" role="group">
            <button type="button" class="${split === "equal" ? "on" : ""}" data-act="split-mode" data-value="equal">Equally</button>
            <button type="button" class="${split === "exact" ? "on" : ""}" data-act="split-mode" data-value="exact">Exact amounts</button>
          </span></p>
        ${
          split === "equal"
            ? `<p class="field"><span class="field-label">Split between · ${participants.length} of ${members.length}</span>
                 ${memberChips(participants, "toggle-participant", false)}</p>
               <button class="btn block" type="button" data-act="all-participants">Everyone in the group</button>`
            : `<p class="field"><span class="field-label">Who owes what</span></p>
               <div class="amounts">${exactRows}</div>
               <button class="btn block" type="button" data-act="fill-equally">Fill equally</button>`
        }
        <p class="summary ${summary.bad ? "bad" : ""}" id="expense-summary">${esc(summary.text)}</p>
        <p class="field"><label for="e-notes">Note (optional)</label>
          <textarea id="e-notes" rows="2" data-field="notes" placeholder="Cash, receipt in Anil's photos">${esc(
            draft.notes || "",
          )}</textarea></p>
      </form>
      <footer class="sheet-foot"><button class="btn primary block" type="button" data-act="submit-expense" ${
        expenseValid(draft) && !state.busy ? "" : "disabled"
      }>${submitLabel("Save expense")}</button></footer>
    </section>`;
  }

  function settleSelection(draft) {
    const members = activeMembers();
    const transfers = state.balances?.suggested_transfers || [];
    const from =
      draft.from && members.some((member) => member.member_id === draft.from)
        ? draft.from
        : members.find((member) => balanceOf(member.member_id) < 0)?.member_id || members[0]?.member_id || null;
    const to =
      draft.to && members.some((member) => member.member_id === draft.to)
        ? draft.to
        : transfers.find((item) => item.from_member_id === from)?.to_member_id ||
          members.find((member) => member.member_id !== from)?.member_id ||
          null;
    const suggested = transfers
      .filter((item) => item.from_member_id === from && item.to_member_id === to)
      .reduce((sum, item) => sum + item.amount_paise, 0);
    const max = suggested || (from && balanceOf(from) < 0 ? -balanceOf(from) : 0);
    return { from, to, max, suggested };
  }

  function settlementSheet() {
    const draft = state.sheet.draft;
    const members = activeMembers();
    const { from, to, max, suggested } = settleSelection(draft);
    const amountPaise = toPaise(draft.amount);
    const valid = Boolean(from) && Boolean(to) && from !== to && amountPaise !== null;

    const picker = (label, selected, act, other) =>
      `<p class="field"><span class="field-label">${label}</span>
        <span class="chips">${members
          .map(
            (member) => `<button class="chip payer ${selected === member.member_id ? "on" : ""}" type="button"
              data-act="${act}" data-value="${esc(member.member_id)}"${
              member.member_id === other ? " disabled" : ""
            }>${esc(member.display_name)}${isMe(member.member_id) ? " (you)" : ""}</button>`,
          )
          .join("")}</span></p>`;

    return `<section class="sheet" role="dialog" aria-modal="true" aria-label="Record settlement">
      ${sheetHead("Record a settlement", "Money that moved outside the app")}
      <form class="sheet-body" data-form="settlement">
        ${picker("Paying", from, "settle-from", to)}
        ${picker("Receiving", to, "settle-to", from)}
        ${
          max
            ? `<button class="btn block" type="button" data-act="use-max">${
                suggested ? "Use the suggested amount" : "Clear what is owed"
              } · ${money(max)}</button>`
            : `<p class="hint">These two have no outstanding amount between them. ${
                from && to ? "You can still record it — a settlement overpays one side and rebalances the group." : ""
              }</p>`
        }
        <div class="split-two">
          <p class="field"><label for="s-amount">Amount</label>
            <span class="money"><span>₹</span>
              <input id="s-amount" type="text" inputmode="decimal" data-field="amount" placeholder="0.00" data-autofocus value="${esc(
                draft.amount ?? "",
              )}" /></span></p>
          <p class="field"><label for="s-date">Date</label>
            <input id="s-date" type="date" data-field="date" value="${esc(draft.date || todayISO())}" /></p>
        </div>
        <p class="field"><span class="field-label">Method</span>
          ${chips(METHODS, draft.method || "upi", "pick-method")}</p>
        <p class="field"><label for="s-notes">Note (optional)</label>
          <input id="s-notes" type="text" data-field="notes" placeholder="UPI ref 4421" value="${esc(draft.notes || "")}" /></p>
        <p class="hint">${
          isMe(from)
            ? "You are paying."
            : isMe(to)
              ? "You are being paid."
              : "Recording for two other people needs the owner or admin role."
        } A settlement is its own ledger entry, so balances re-derive on the next read.</p>
      </form>
      <footer class="sheet-foot"><button class="btn primary block" type="button" data-act="submit-settlement" ${
        valid && !state.busy ? "" : "disabled"
      }>${submitLabel("Record settlement")}</button></footer>
    </section>`;
  }

  function personSheet() {
    const draft = state.sheet.draft;
    const canManage = ["owner", "admin"].includes(state.group.role);
    const inGroup = new Set(state.roster.map((member) => member.user_id));
    const available = state.users.filter((user) => !inGroup.has(user.id));
    const role = draft.role || "member";
    const disabled = !canManage || state.busy;

    return `<section class="sheet" role="dialog" aria-modal="true" aria-label="Add people">
      ${sheetHead("Add people", state.group.name)}
      <form class="sheet-body" data-form="person-add">
        ${
          canManage
            ? ""
            : `<p class="summary bad">The API lets only an owner or admin add members, and you are a ${esc(
                state.group.role,
              )}.</p>`
        }
        <p class="field"><span class="field-label">Role for the people you add</span>
          <span class="segment" role="group">
            <button type="button" class="${role === "member" ? "on" : ""}" data-act="pick-role" data-value="member">Member</button>
            <button type="button" class="${role === "admin" ? "on" : ""}" data-act="pick-role" data-value="admin">Admin</button>
          </span></p>
        ${
          available.length
            ? `<p class="eyebrow">People on this server</p>
               <div class="card list-scroll">${available
                 .map(
                   (user) => `<div class="row">
                     ${avatar(user.display_name, user.id)}
                     <span class="row-main"><p class="row-title">${esc(user.display_name)}</p>
                       <p class="row-sub">${esc(user.email)}</p></span>
                     <button class="btn" type="button" data-act="add-existing" data-value="${esc(user.id)}"${
                       disabled ? " disabled" : ""
                     }>${
                       state.roster.some((member) => member.user_id === user.id && member.status !== "active")
                         ? "Rejoin"
                         : "Add"
                     }</button>
                   </div>`,
                 )
                 .join("")}</div>`
            : `<p class="hint">Nobody else is on this server yet — create a person below and they join straight away.</p>`
        }
        <p class="eyebrow">Or create and add</p>
        <div class="split-two">
          <p class="field"><label for="n-name">Name</label>
            <input id="n-name" type="text" data-field="new_name" data-autofocus placeholder="Beena" value="${esc(
              draft.new_name || "",
            )}" /></p>
          <p class="field"><label for="n-email">Email</label>
            <input id="n-email" type="email" data-field="new_email" placeholder="beena@example.com" value="${esc(
              draft.new_email || "",
            )}" /></p>
        </div>
        <button class="btn primary block" type="button" data-act="create-and-add"${disabled ? " disabled" : ""}>${submitLabel(
          "Create and add",
        )}</button>
        <p class="hint">Invitations are a later milestone, so this uses the documented bootstrap add: only people who already exist on this server can join a group.</p>
      </form>
    </section>`;
  }

  function switchSheet() {
    return `<section class="sheet" role="dialog" aria-modal="true" aria-label="Switch person">
      ${sheetHead("This device", "No sign-in yet, so the app asks who is holding it")}
      <form class="sheet-body" data-form="switch">
        <div class="card">${state.users
          .map(
            (user) => `<button class="row row-button" type="button" data-act="sign-in" data-value="${esc(user.id)}">
              ${avatar(user.display_name, user.id)}
              <span class="row-main"><p class="row-title">${esc(user.display_name)}</p>
                <p class="row-sub">${esc(user.email)}</p></span>
              ${user.id === state.user.id ? '<span class="tag accent">current</span>' : ""}
            </button>`,
          )
          .join("")}</div>
        <button class="btn block" type="button" data-act="create-person">Add another person</button>
        <button class="btn block danger" type="button" data-act="sign-out">Forget this device</button>
      </form>
    </section>`;
  }

  function detailSheet(sheet) {
    const expense = findExpense(sheet.id);
    if (!expense) {
      return `<section class="sheet" role="dialog" aria-modal="true">
        ${sheetHead("Expense", "It is not in the loaded page")}
        <div class="sheet-body"><p class="hint">Pull a refresh from the header and open it again.</p></div>
      </section>`;
    }
    const shares = [...expense.shares].sort((left, right) =>
      memberName(left.member_id).localeCompare(memberName(right.member_id)),
    );
    return `<section class="sheet" role="dialog" aria-modal="true" aria-label="Expense detail">
      ${sheetHead(expense.description, `${dayLabel(expense.expense_date)} · ${categoryLabel(expense.category)}`)}
      <div class="sheet-body">
        <div class="card pad">
          <span class="field-label">Total</span>
          <p class="detail-amount">${money(expense.amount_paise)}</p>
        </div>
        <p class="eyebrow">Paid by</p>
        <div class="card"><div class="row">
          ${avatar(memberName(expense.payer.member_id), expense.payer.member_id)}
          <span class="row-main"><p class="row-title">${esc(memberName(expense.payer.member_id))}${
            isMe(expense.payer.member_id) ? " (you)" : ""
          }</p></span>
          <span class="row-amount pos">+${money(expense.payer.amount_paise)}</span>
        </div></div>
        <p class="eyebrow">Shares · ${expense.split_method}</p>
        <div class="card">${shares
          .map(
            (share) => `<div class="row">
              ${avatar(memberName(share.member_id), share.member_id, "sm")}
              <span class="row-main"><p class="row-title">${esc(memberName(share.member_id))}${
                isMe(share.member_id) ? " (you)" : ""
              }</p></span>
              <span class="row-amount neg">-${money(share.owed_paise)}</span>
            </div>`,
          )
          .join("")}
          <div class="row"><span class="row-main"><p class="row-title muted">Sum of shares</p></span>
            <span class="row-amount">${money(shares.reduce((sum, share) => sum + share.owed_paise, 0))}</span></div>
        </div>
        ${expense.notes ? `<p class="hint">${esc(expense.notes)}</p>` : ""}
        <p class="hint">Version ${expense.version}. Shares are written with the expense, so this split can never drift from the total. Editing and soft-deleting are not in the API yet.</p>
      </div>
      <footer class="sheet-foot"><button class="btn block" type="button" data-act="close-sheet">Close</button></footer>
    </section>`;
  }

  // -------------------------------------------------------------- behaviour

  const actions = {
    back: () => go("#/"),
    "pick-person": () => {
      state.onboardingCreate = false;
      render();
    },
    refresh: async () => {
      if (route().name === "group" && state.group) {
        await loadGroup();
      } else {
        await loadGroups();
      }
      toast("Up to date");
    },
    "dismiss-error": () => {
      state.error = null;
      render();
    },
    "switch-person": () => openSheet({ kind: "switch" }),
    "create-person": () => {
      closeSheet();
      state.onboardingCreate = true;
      render();
      const field = document.getElementById("p-name");
      if (field) field.focus();
    },
    "sign-in": (dataset) => signIn(dataset.value || dataset.userId),
    "sign-out": () => {
      store.clear(SESSION_KEY);
      store.clear(GROUP_KEY);
      Object.assign(state, {
        user: null,
        groups: [],
        group: null,
        loadedGroup: "",
        roster: [],
        balances: null,
        expenses: [],
        settlements: [],
        groupOutstanding: new Map(),
        onboardingCreate: true,
        error: null,
      });
      closeSheet();
      if (window.location.hash) window.location.hash = "";
      render();
    },
    // The hash change is the single trigger for loading; no second call here.
    "open-group": (dataset) => go(`#/g/${dataset.groupId}/balances`),
    "new-group": () => openSheet({ kind: "group", draft: { name: "", description: "", simplify_debts: true } }),
    "create-group": () => submitGroup(),
    tab: (dataset) => {
      state.tab = dataset.tab;
      go(`#/g/${state.group.group_id}/${dataset.tab}`);
    },
    "add-expense": () => openExpenseSheet(),
    "add-person": () => openSheet({ kind: "person", draft: {} }),
    "expense-detail": (dataset) => openSheet({ kind: "detail", id: dataset.id }),
    "pick-payer": (dataset) => {
      state.sheet.draft.payer = dataset.value;
      renderSheet();
    },
    "toggle-participant": (dataset) => {
      const draft = state.sheet.draft;
      const participants = draft.participants || activeMembers().map((member) => member.member_id);
      draft.participants = participants.includes(dataset.value)
        ? participants.filter((id) => id !== dataset.value)
        : [...participants, dataset.value];
      renderSheet();
    },
    "all-participants": () => {
      state.sheet.draft.participants = activeMembers().map((member) => member.member_id);
      renderSheet();
    },
    "pick-category": (dataset) => {
      const draft = state.sheet.draft;
      draft.category = draft.category === dataset.value ? "" : dataset.value;
      renderSheet();
    },
    "split-mode": (dataset) => {
      const draft = state.sheet.draft;
      draft.split = dataset.value;
      if (dataset.value === "exact") seedExact(draft);
      renderSheet();
    },
    "fill-equally": () => {
      const draft = state.sheet.draft;
      const amount = toPaise(draft.amount);
      if (amount === null) {
        toast("Enter the amount first", true);
        return;
      }
      draft.exact = distribute(amount, (draft.participants || activeMembers().map((m) => m.member_id)).slice());
      renderSheet();
    },
    "submit-expense": () => submitExpense(),
    "settle-from": (dataset) => {
      const draft = state.sheet.draft;
      draft.from = dataset.value;
      if (draft.to === dataset.value) draft.to = null;
      renderSheet();
    },
    "settle-to": (dataset) => {
      const draft = state.sheet.draft;
      draft.to = dataset.value;
      if (draft.from === dataset.value) draft.from = null;
      renderSheet();
    },
    "use-max": () => {
      const draft = state.sheet.draft;
      const { from, to, max } = settleSelection(draft);
      if (!max) {
        toast("Nothing is owed between them", true);
        return;
      }
      draft.from = from;
      draft.to = to;
      draft.amount = paiseToInput(max);
      renderSheet();
    },
    "pick-method": (dataset) => {
      state.sheet.draft.method = dataset.value;
      renderSheet();
    },
    "pick-role": (dataset) => {
      state.sheet.draft.role = dataset.value;
      renderSheet();
    },
    "submit-settlement": () => submitSettlement(),
    "settle-up": () => openSheet({ kind: "settlement", draft: {} }),
    "record-transfer": (dataset) => {
      const transfer = (state.balances?.suggested_transfers || [])[Number(dataset.index)];
      if (!transfer) return;
      openSheet({
        kind: "settlement",
        draft: {
          from: transfer.from_member_id,
          to: transfer.to_member_id,
          amount: paiseToInput(transfer.amount_paise),
          method: "upi",
          date: todayISO(),
        },
      });
    },
    "add-existing": (dataset) => addExisting(dataset.value),
    "create-and-add": () => createAndAdd(),
    "close-sheet": () => closeSheet(),
  };

  /**
   * Same distribution the server applies: sort by member id, hand the leftover
   * paise to the first few. The draft holds rupee *text*, exactly as the field
   * would contain it, so typed and filled values share one representation.
   */
  function distribute(amountPaise, memberIds) {
    const sorted = [...memberIds].sort((left, right) => (left < right ? -1 : 1));
    const base = Math.floor(amountPaise / sorted.length);
    const remainder = amountPaise % sorted.length;
    const exact = {};
    sorted.forEach((memberId, index) => {
      exact[memberId] = paiseToInput(base + (index < remainder ? 1 : 0));
    });
    return exact;
  }

  function openExpenseSheet() {
    const members = activeMembers();
    if (!members.length) {
      toast("Add a person to this group first", true);
      openSheet({ kind: "person", draft: {} });
      return;
    }
    const me = myMemberId();
    openSheet({
      kind: "expense",
      draft: {
        description: "",
        amount: "",
        date: todayISO(),
        category: "",
        notes: "",
        split: "equal",
        payer: members.some((member) => member.member_id === me) ? me : members[0].member_id,
        participants: members.map((member) => member.member_id),
        exact: {},
      },
    });
  }

  function seedExact(draft) {
    const amount = toPaise(draft.amount);
    if (amount === null || (draft.exact && Object.keys(draft.exact).length)) return;
    const participants = (draft.participants || []).length
      ? draft.participants
      : activeMembers().map((member) => member.member_id);
    draft.exact = distribute(amount, participants);
  }

  async function signIn(userId) {
    const person = state.users.find((user) => user.id === userId);
    if (!person) {
      toast("That person no longer exists", true);
      return;
    }
    adoptUser(person);
    store.set(SESSION_KEY, { userId: person.id });
    state.onboardingCreate = false;
    state.group = null;
    state.loadedGroup = "";
    closeSheet();
    if (window.location.hash) window.location.hash = "";
    await loadGroups();
    toast(`Signed in as ${person.display_name}`);
  }

  function formFields(form) {
    const fields = {};
    if (!form) return fields;
    for (const element of form.querySelectorAll("[data-field]")) {
      fields[element.dataset.field] = element.type === "checkbox" ? element.checked : element.value;
    }
    return fields;
  }

  async function submitPersonForm(form) {
    const fields = formFields(form);
    const displayName = String(fields.display_name || "").trim();
    const email = String(fields.email || "").trim() || `${slug(displayName)}@share.local`;
    if (!displayName) {
      toast("Add a name first", true);
      return;
    }
    if (!email.includes("@")) {
      toast("That email needs an @", true);
      return;
    }
    await mutate(
      async () => {
        const created = await api("/v1/users", {
          method: "POST",
          body: { email, display_name: displayName },
        });
        state.users = (await api("/v1/users")) || state.users;
        adoptUser(created);
        store.set(SESSION_KEY, { userId: created.id });
        state.mainDraft = {};
      },
      "groups",
    );
    if (state.user) toast(`Hi ${displayName}. Now make a group.`);
  }

  async function submitGroup() {
    const fields = formFields(sheetRoot.querySelector('[data-form="group"]'));
    const name = String(fields.name || "").trim();
    if (!name) {
      toast("Groups need a name", true);
      return;
    }
    await mutate(
      async () => {
        await api("/v1/groups", {
          method: "POST",
          body: {
            owner_user_id: state.user.id,
            name,
            ...(fields.description ? { description: String(fields.description).trim() } : {}),
            simplify_debts: fields.simplify_debts !== false,
          },
        });
      },
      "none",
    );
    if (!state.error) {
      await loadGroups();
      const newest = state.groups[0];
      if (newest) go(`#/g/${newest.group_id}/balances`);
      toast(`Created ${name}`);
    }
  }

  async function submitExpense() {
    const draft = state.sheet.draft;
    const amountPaise = toPaise(draft.amount);
    const split = draft.split || "equal";
    const description = String(draft.description || "").trim();
    if (!description) return toast("What was the expense?", true);
    if (amountPaise === null) return toast("Amount must be a positive ₹ value", true);
    if (!draft.payer) return toast("Pick who paid", true);
    if (!draft.date) return toast("Pick a date", true);

    const body = {
      actor_member_id: myMemberId(),
      payer_member_id: draft.payer,
      description,
      amount_paise: amountPaise,
      expense_date: draft.date,
      split_method: split,
      ...(draft.category ? { category: draft.category } : {}),
      ...(draft.notes ? { notes: String(draft.notes).trim() } : {}),
    };
    if (split === "exact") {
      body.exact_shares = exactShares(draft, activeMembers());
      if (body.exact_shares.reduce((sum, share) => sum + share.owed_paise, 0) !== amountPaise) {
        return toast("Exact shares must add up to the amount", true);
      }
    } else {
      if (!(draft.participants || []).length) return toast("Pick who to split with", true);
      if (amountPaise < draft.participants.length) return toast("Amount is below one paise per person", true);
      body.participant_member_ids = draft.participants;
    }

    await mutate(async () => {
      await api(`/v1/groups/${state.group.group_id}/expenses`, { method: "POST", body });
      toast(`Saved ${money(amountPaise)}`);
    });
  }

  async function submitSettlement() {
    const draft = state.sheet.draft;
    const { from, to } = settleSelection(draft);
    const amountPaise = toPaise(draft.amount);
    if (!from || !to) return toast("Pick two people", true);
    if (from === to) return toast("Payer and receiver must be different", true);
    if (amountPaise === null) return toast("Enter the amount", true);

    await mutate(async () => {
      await api(`/v1/groups/${state.group.group_id}/settlements`, {
        method: "POST",
        body: {
          actor_member_id: myMemberId(),
          paid_by_member_id: from,
          received_by_member_id: to,
          amount_paise: amountPaise,
          settlement_date: draft.date || todayISO(),
          payment_method: draft.method || "upi",
          ...(draft.notes ? { notes: String(draft.notes).trim() } : {}),
        },
      });
      toast(`Recorded ${money(amountPaise)}`);
    });
  }

  async function addExisting(userId) {
    await mutate(async () => {
      await api(`/v1/groups/${state.group.group_id}/members`, {
        method: "POST",
        body: { actor_member_id: myMemberId(), user_id: userId, role: state.sheet?.draft.role || "member" },
      });
    });
    if (!state.error) toast("Added to the group");
  }

  async function createAndAdd() {
    const fields = formFields(sheetRoot.querySelector('[data-form="person-add"]'));
    const displayName = String(fields.new_name || "").trim();
    if (!displayName) return toast("Add a name first", true);
    const email = String(fields.new_email || "").trim() || `${slug(displayName)}@share.local`;
    await mutate(async () => {
      const created = await api("/v1/users", { method: "POST", body: { email, display_name: displayName } });
      state.users = (await api("/v1/users")) || state.users;
      await api(`/v1/groups/${state.group.group_id}/members`, {
        method: "POST",
        body: {
          actor_member_id: myMemberId(),
          user_id: created.id,
          role: state.sheet?.draft.role || "member",
        },
      });
    });
    if (!state.error) toast(`${displayName} joined the group`);
  }

  // ------------------------------------------------------------- listeners

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (!target || target.disabled) return;
    const handler = actions[target.dataset.act];
    if (!handler) return;
    event.preventDefault();
    void handler(target.dataset, event);
  });

  /**
   * Text input only updates the draft and the live bits (summary, submit
   * button). Re-rendering on every keystroke would move the caret.
   */
  document.addEventListener("input", (event) => {
    const element = event.target.closest("[data-field]");
    if (!element) return;
    const inSheet = Boolean(state.sheet) && Boolean(element.closest(".sheet"));
    const draft = inSheet ? state.sheet.draft : state.mainDraft;
    const key = element.dataset.field;

    if (key.startsWith("amount:")) {
      draft.exact = draft.exact || {};
      draft.exact[key.slice(7)] = element.value;
    } else if (element.type === "checkbox") {
      draft[key] = element.checked;
    } else {
      draft[key] = element.value;
    }

    if (!inSheet) return;
    if (state.sheet.kind === "expense") {
      const summary = expenseSummary(draft);
      const summaryEl = document.getElementById("expense-summary");
      if (summaryEl) {
        summaryEl.textContent = summary.text;
        summaryEl.classList.toggle("bad", summary.bad);
      }
      setSubmitEnabled("submit-expense", expenseValid(draft));
    } else if (state.sheet.kind === "settlement") {
      const { from, to } = settleSelection(draft);
      setSubmitEnabled("submit-settlement", Boolean(from) && Boolean(to) && from !== to && toPaise(draft.amount) !== null);
    }
  });

  function setSubmitEnabled(act, enabled) {
    const button = sheetRoot.querySelector(`[data-act="${act}"]`);
    if (button) button.disabled = !(enabled && !state.busy);
  }

  document.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.target.dataset.form === "person") void submitPersonForm(event.target);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.sheet) closeSheet();
  });

  window.addEventListener("hashchange", () => {
    const current = route();
    if (current.name !== "group") {
      state.tab = "balances";
      render();
      return;
    }
    state.tab = current.tab;
    if (!state.user) {
      render();
      return;
    }
    if (state.loadedGroup === current.groupId) {
      render();
      return;
    }
    void openGroup(current.groupId).catch((error) => {
      state.error = error.message;
      render();
    });
  });

  // -------------------------------------------------------------- startup

  async function start() {
    await boot();
    const current = route();
    if (current.name !== "group" && state.user && state.groups.length) {
      const remembered = store.get(GROUP_KEY);
      if (remembered?.userId === state.user.id && state.groups.some((group) => group.group_id === remembered.groupId)) {
        go(`#/g/${remembered.groupId}/${state.tab}`);
      }
    }
    if (current.name === "group" && state.user && state.loadedGroup !== current.groupId) {
      await openGroup(current.groupId);
    }
  }

  start().catch((error) => {
    state.error = error.message;
    render();
  });
})();
