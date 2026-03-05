import type { SupabaseClient } from "@supabase/supabase-js";

export type ConnectorProvider = "slack" | "google";

export type ConnectorAccountRow = {
  id: string;
  org_id: string;
  provider: ConnectorProvider;
  external_account_id: string;
  display_name: string | null;
  secrets_json: Record<string, unknown>;
  created_at: string;
};

type GetConnectorAccountArgs = {
  supabase: SupabaseClient;
  orgId: string;
  provider: ConnectorProvider;
};

type UpsertConnectorAccountArgs = {
  supabase: SupabaseClient;
  orgId: string;
  provider: ConnectorProvider;
  externalAccountId: string;
  displayName?: string | null;
  secrets: Record<string, unknown>;
};

export async function getConnectorAccount(args: GetConnectorAccountArgs): Promise<ConnectorAccountRow | null> {
  const { supabase, orgId, provider } = args;
  const { data, error } = await supabase
    .from("connector_accounts")
    .select("id, org_id, provider, external_account_id, display_name, secrets_json, created_at")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load ${provider} connector account: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id as string,
    org_id: data.org_id as string,
    provider: data.provider as ConnectorProvider,
    external_account_id: data.external_account_id as string,
    display_name: (data.display_name as string | null) ?? null,
    secrets_json: (data.secrets_json as Record<string, unknown>) ?? {},
    created_at: data.created_at as string
  };
}

export async function upsertConnectorAccount(args: UpsertConnectorAccountArgs): Promise<ConnectorAccountRow> {
  const { supabase, orgId, provider, externalAccountId, displayName = null, secrets } = args;
  const latest = await getConnectorAccount({ supabase, orgId, provider });

  if (latest) {
    const { data, error } = await supabase
      .from("connector_accounts")
      .update({
        external_account_id: externalAccountId,
        display_name: displayName,
        secrets_json: secrets
      })
      .eq("id", latest.id)
      .eq("org_id", orgId)
      .select("id, org_id, provider, external_account_id, display_name, secrets_json, created_at")
      .single();

    if (error) {
      throw new Error(`Failed to update ${provider} connector account: ${error.message}`);
    }

    return {
      id: data.id as string,
      org_id: data.org_id as string,
      provider: data.provider as ConnectorProvider,
      external_account_id: data.external_account_id as string,
      display_name: (data.display_name as string | null) ?? null,
      secrets_json: (data.secrets_json as Record<string, unknown>) ?? {},
      created_at: data.created_at as string
    };
  }

  const { data, error } = await supabase
    .from("connector_accounts")
    .insert({
      org_id: orgId,
      provider,
      external_account_id: externalAccountId,
      display_name: displayName,
      secrets_json: secrets
    })
    .select("id, org_id, provider, external_account_id, display_name, secrets_json, created_at")
    .single();

  if (error) {
    throw new Error(`Failed to create ${provider} connector account: ${error.message}`);
  }

  return {
    id: data.id as string,
    org_id: data.org_id as string,
    provider: data.provider as ConnectorProvider,
    external_account_id: data.external_account_id as string,
    display_name: (data.display_name as string | null) ?? null,
    secrets_json: (data.secrets_json as Record<string, unknown>) ?? {},
    created_at: data.created_at as string
  };
}
