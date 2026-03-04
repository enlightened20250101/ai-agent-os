const requiredServerEnv = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const serviceRoleEnv = "SUPABASE_SERVICE_ROLE_KEY";

function getEnvVar(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

export function getSupabaseEnv() {
  const [urlKey, anonKey] = requiredServerEnv;

  return {
    url: getEnvVar(urlKey),
    anonKey: getEnvVar(anonKey)
  };
}

export function getSupabaseServiceRoleKey() {
  return getEnvVar(serviceRoleEnv);
}
