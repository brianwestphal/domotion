/** Shared browser POST decoding for Studio and Scrubber. */
async function postResponse(path: string, body: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return response;

  let error: unknown;
  try {
    error = await response.json();
  } catch {
    throw new Error(`Request failed (${response.status})`);
  }
  if (error != null && typeof error === "object") {
    const details = error as { error?: unknown; issues?: unknown };
    if (typeof details.error === "string") {
      throw Object.assign(new Error(details.error), { error: details.error, issues: details.issues });
    }
  }
  throw new Error(`Request failed (${response.status})`);
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await postResponse(path, body);
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${path}`);
  }
}

export async function postBlob(path: string, body: unknown): Promise<Blob> {
  return (await postResponse(path, body)).blob();
}
