import { getStore } from "@netlify/blobs";

const MAX_FAMILIES = 30;
const MAX_MEMBERS = 15;

const key = (name) => name.trim().toLowerCase().replace(/\s+/g, " ");
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// people: [{ name, family }]. Returns Map(giverName -> recipientName) where
// nobody draws themselves or anyone from their own family.
function draw(people, random = Math.random) {
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const sizes = {};
  for (const p of people) sizes[p.family] = (sizes[p.family] || 0) + 1;
  const families = Object.keys(sizes);
  if (families.length < 2) throw new HttpError("Need at least two families before drawing.");
  const biggest = Math.max(...Object.values(sizes));
  if (biggest * 2 > people.length) {
    const fam = families.find((f) => sizes[f] === biggest);
    throw new Error(
      `${fam} has ${biggest} of ${people.length} people, which is more than half. ` +
        `Someone in that family would have to draw their own family. Add more people from other families.`
    );
  }

  const options = new Map(
    people.map((g) => [g.name, people.filter((r) => r.family !== g.family).map((r) => r.name)])
  );
  const result = new Map();
  const taken = new Set();
  let steps = 0;

  const solve = () => {
    if (result.size === people.length) return true;
    if (++steps > 200000) return false;
    // Pick the giver with the fewest remaining choices.
    let best = null;
    let bestOpts = null;
    for (const p of people) {
      if (result.has(p.name)) continue;
      const opts = options.get(p.name).filter((n) => !taken.has(n));
      if (!best || opts.length < bestOpts.length) {
        best = p;
        bestOpts = opts;
      }
    }
    if (bestOpts.length === 0) return false;
    for (const r of shuffle(bestOpts)) {
      result.set(best.name, r);
      taken.add(r);
      if (solve()) return true;
      result.delete(best.name);
      taken.delete(r);
    }
    return false;
  };

  if (!solve()) throw new Error("Could not find a valid draw. Try again or check the families.");
  return result;
}

const store = () => getStore({ name: "davis-exchange", consistency: "strong" });

async function loadFamilies(s) {
  const { blobs } = await s.list({ prefix: "family/" });
  const fams = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return fams.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
const peopleOf = (families) => families.flatMap((f) => f.members.map((name) => ({ name, family: f.name })));
const findPerson = (families, name) => peopleOf(families).find((p) => key(p.name) === key(String(name ?? "")));

function checkPin(pin) {
  const expected = Netlify.env.get("ORGANIZER_PIN");
  if (!expected) throw new HttpError("The organizer PIN has not been set up yet.", 500);
  if (String(pin ?? "") !== String(expected)) throw new HttpError("That PIN is not right.", 403);
}

export async function handle(s, route, body) {
  const assignments = await s.get("assignments", { type: "json" });

  if (route === "state") {
    const families = await loadFamilies(s);
    return { drawn: !!assignments, families };
  }

  if (route === "family") {
    if (assignments) throw new HttpError("The draw is done, so families can't change. Ask the organizer to reset it.", 409);
    const name = clean(body.name);
    if (!name) throw new HttpError('Give your family a name, like "Tyler\'s family".');
    const members = [];
    const seen = new Set();
    for (const raw of body.members ?? []) {
      const m = clean(raw);
      if (!m || seen.has(key(m))) continue;
      seen.add(key(m));
      members.push(m);
    }
    if (members.length === 0) throw new HttpError("Add at least one person.");
    if (members.length > MAX_MEMBERS) throw new HttpError(`A family can have up to ${MAX_MEMBERS} people.`);

    const families = await loadFamilies(s);
    const id = key(name).replace(/[^\p{L}\p{N}]+/gu, "-");
    const oldId = body.id ? String(body.id) : null;
    const others = families.filter((f) => f.id !== id && f.id !== oldId);
    if (!oldId && families.some((f) => f.id === id)) {
      throw new HttpError(`"${name}" is already signed up. Edit it from the list below.`);
    }
    if (others.length + 1 > MAX_FAMILIES) throw new HttpError("That's too many families.");
    for (const f of others) {
      for (const m of f.members) {
        if (seen.has(key(m))) {
          throw new HttpError(`${m} is already in ${f.name}. If two people share a name, add a last initial to one.`);
        }
      }
    }
    if (oldId && oldId !== id) await s.delete("family/" + oldId);
    await s.setJSON("family/" + id, { id, name, members });
    return { ok: true };
  }

  if (route === "remove-family") {
    if (assignments) throw new HttpError("The draw is done, so families can't change.", 409);
    await s.delete("family/" + String(body.id ?? "").replace(/\//g, ""));
    return { ok: true };
  }

  if (route === "ideas") {
    const person = findPerson(await loadFamilies(s), body.name);
    if (!person) throw new HttpError("Pick your name first.");
    const text = String(body.text ?? "").trim().slice(0, 2000);
    if (text) await s.setJSON("idea/" + key(person.name), { text });
    else await s.delete("idea/" + key(person.name));
    return { ok: true };
  }

  if (route === "me") {
    const person = findPerson(await loadFamilies(s), body.name);
    if (!person) throw new HttpError("We couldn't find that name.");
    const ideaOf = async (name) => (await s.get("idea/" + key(name), { type: "json" }))?.text ?? "";
    const out = { name: person.name, family: person.family, drawn: !!assignments, myIdeas: await ideaOf(person.name) };
    const recipient = assignments?.[key(person.name)];
    if (recipient) out.recipient = { name: recipient, ideas: await ideaOf(recipient) };
    return out;
  }

  if (route === "check") {
    const families = await loadFamilies(s);
    const people = peopleOf(families);
    const counts = { people: people.length, families: families.length };
    try {
      draw(people);
      return { ready: true, ...counts };
    } catch (err) {
      return { ready: false, reason: err.message, ...counts };
    }
  }

  if (route === "draw" || route === "reset") {
    checkPin(body.pin);
    if (route === "reset") {
      await s.delete("assignments");
      return { ok: true };
    }
    if (assignments) throw new HttpError("The draw is already done.", 409);
    const result = draw(peopleOf(await loadFamilies(s)));
    const out = {};
    for (const [giver, recipient] of result) out[key(giver)] = recipient;
    await s.setJSON("assignments", out);
    return { ok: true, count: result.size };
  }

  throw new HttpError("Not found", 404);
}

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\//, "");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  try {
    return Response.json(await handle(store(), route, body), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: err.message }, { status: err instanceof HttpError ? err.status : 400 });
  }
};

export const config = { path: "/api/*" };
