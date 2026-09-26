// Replaces https://esm.sh/@supabase/supabase-js@2 when the function runs under test.
export function createClient(_url, key) {
  if (key === "service-role-key") return globalThis.__fakeDb;
  return {
    auth: {
      async getUser(token) {
        const user = globalThis.__fakeUsers[token];
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
      },
    },
  };
}
