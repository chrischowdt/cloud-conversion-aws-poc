// App function: proxy for Dynatrace Config API v1 classic dashboard endpoints.
//
// Classic API lives on the classic tenant host (e.g. abc123.dynatrace.com), not
// the AppEngine host (abc123.apps.dynatrace.com). Browser-side fetch to that
// host is blocked by the AppEngine CSP, so this server-side function performs
// the request instead. The external host must be listed in the Dynatrace
// environment's allowed outbound hosts:
//   Settings → General → Environment management → External requests
//   Add: *.dynatracelabs.com, *.dynatrace.com

type Payload = {
  token: string;
  /** Relative path, e.g. /api/config/v1/dashboards or /api/config/v1/dashboards/{id} */
  path: string;
  /** Classic tenant base URL, e.g. https://abc123.dynatrace.com */
  classicBaseUrl: string;
};

// Only allow Config V1 dashboard list and detail endpoints
const ALLOWED_PATH_RE = /^\/api\/config\/v1\/dashboards(\/[0-9a-f-]+)?$/i;

// Only allow recognised Dynatrace tenant hostnames
const ALLOWED_BASE_URL_RE = /^https:\/\/[a-z0-9][a-z0-9.-]*\.dynatrace(labs)?\.com$/i;

export default async function (payload: unknown): Promise<unknown> {
  const { token, path, classicBaseUrl } = payload as Payload;

  if (!ALLOWED_PATH_RE.test(path)) {
    throw new Error(`Disallowed path: ${path}`);
  }

  if (!ALLOWED_BASE_URL_RE.test(classicBaseUrl)) {
    throw new Error(`Disallowed base URL: ${classicBaseUrl}`);
  }

  const response = await fetch(`${classicBaseUrl}${path}`, {
    headers: { Authorization: `Api-Token ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status} for ${path}`);
  }

  return response.json() as Promise<unknown>;
}
