"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/lib/org/context";
import { createClient } from "@/lib/supabase/server";
import { appendTaskEvent, getOrCreateAgentOpsTaskId } from "@/lib/events/taskEvents";

function toErrorRedirect(message: string) {
  return `/app/agents?error=${encodeURIComponent(message)}`;
}

export async function createAgent(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const roleKey = String(formData.get("role_key") ?? "").trim();

  if (!name || !roleKey) {
    redirect(toErrorRedirect("name と role_key は必須です。"));
  }

  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: createdAgent, error: createError } = await supabase
    .from("agents")
    .insert({
      org_id: orgId,
      name,
      role_key: roleKey,
      status: "active"
    })
    .select("id, name, role_key, status")
    .single();

  if (createError) {
    redirect(toErrorRedirect(createError.message));
  }

  const opsTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: opsTaskId,
    actorId: userId,
    eventType: "AGENT_CREATED",
    payload: {
      agent_id: createdAgent.id,
      changed_fields: {
        name: createdAgent.name,
        role_key: createdAgent.role_key,
        status: createdAgent.status
      }
    }
  });

  revalidatePath("/app/agents");
  revalidatePath("/app/tasks");
}

export async function toggleAgentStatus(formData: FormData) {
  const agentId = String(formData.get("agent_id") ?? "");
  const currentStatus = String(formData.get("current_status") ?? "");

  if (!agentId || (currentStatus !== "active" && currentStatus !== "disabled")) {
    redirect(toErrorRedirect("エージェント状態更新リクエストが不正です。"));
  }

  const nextStatus = currentStatus === "active" ? "disabled" : "active";
  const { orgId, userId } = await requireOrgContext();
  const supabase = await createClient();

  const { data: updatedAgent, error: updateError } = await supabase
    .from("agents")
    .update({ status: nextStatus })
    .eq("id", agentId)
    .eq("org_id", orgId)
    .select("id, status")
    .single();

  if (updateError) {
    redirect(toErrorRedirect(updateError.message));
  }

  const opsTaskId = await getOrCreateAgentOpsTaskId({ supabase, orgId, userId });
  await appendTaskEvent({
    supabase,
    orgId,
    taskId: opsTaskId,
    actorId: userId,
    eventType: "AGENT_UPDATED",
    payload: {
      agent_id: updatedAgent.id,
      changed_fields: {
        status: updatedAgent.status
      }
    }
  });

  revalidatePath("/app/agents");
  revalidatePath("/app/tasks");
}
