interface Env {
  AIOS_MIRROR: DurableObjectNamespace;
}

export const onRequest: PagesFunction<Env> = async ({ request, env, params }) => {
  const raw = params.room;
  const room = Array.isArray(raw) ? raw.join("-") : raw || "default";
  const id = env.AIOS_MIRROR.idFromName(room);
  return env.AIOS_MIRROR.get(id).fetch(request);
};
