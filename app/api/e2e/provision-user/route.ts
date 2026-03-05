import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function isProvisionEnabled() {
  return process.env.NODE_ENV === "test" || process.env.E2E_MODE === "1";
}

function isAlreadyExistsError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("already") || normalized.includes("exists");
}

type ProvisionUserBody = {
  email?: string;
  password?: string;
};

export async function POST(request: Request) {
  if (!isProvisionEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const expectedToken = process.env.E2E_CLEANUP_TOKEN;
  const providedToken = request.headers.get("x-e2e-cleanup-token");
  if (!expectedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as ProvisionUserBody | null;
  const email = body?.email?.trim();
  const password = body?.password;

  if (!email || !password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (error) {
    if (isAlreadyExistsError(error.message)) {
      return NextResponse.json({ ok: true, existed: true });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, userId: data.user?.id ?? null, existed: false });
}
