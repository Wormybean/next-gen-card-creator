// Calls into the add-on's Python (addon/__init__.py). Anki gives its pages pycmd(), which
// passes a string to Python and hands back what the handler returns. Slow handlers (fetching
// a web page) answer later by calling window.__ngccDone with the same id.

declare function pycmd(message: string, callback?: (result: unknown) => void): void;

type Reply = { ok: true; value: unknown } | { ok: false; error: string } | { pending: true };

let nextId = 0;
const waiting = new Map<number, (reply: Reply) => void>();

(window as unknown as { __ngccDone: (id: number, reply: Reply) => void }).__ngccDone = (id, reply) => {
  waiting.get(id)?.(reply);
  waiting.delete(id);
};

export function py<T>(name: string, arg?: unknown): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    const settle = (reply: Reply) => {
      if ("pending" in reply) return waiting.set(id, settle);
      if (reply.ok) resolve(reply.value as T);
      else reject(new Error(reply.error));
    };
    pycmd(JSON.stringify({ id, name, arg: arg ?? null }), (reply) => settle(reply as Reply));
  });
}

/** Where this add-on's files are served from, e.g. "/_addons/next_gen_card_creator/". */
export const addonBase = location.pathname.replace(/web\/[^/]*$/, "");
