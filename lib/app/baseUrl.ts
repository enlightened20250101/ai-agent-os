export function getAppBaseUrl() {
  const baseUrl = process.env.APP_BASE_URL?.trim();
  if (!baseUrl) {
    return "http://localhost:3000";
  }
  return baseUrl.replace(/\/+$/, "");
}

