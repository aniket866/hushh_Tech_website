import type {
  BrowserContext,
  Route,
  WebSocketRoute,
} from "@playwright/test";

const FORBIDDEN_PROJECT_REFS = Object.freeze([
  "ibsisfnjxeowvdtvgzff",
  "gsqmwxqgqrgzhlhmbscg",
  "hkdlmkpqwbjnmcwlxczv",
  "jbvfjyxpjyspafqzohmi",
  "qoeqfmeimagulpzjptbj",
  "rpmzykoxqnbozgdoqbpc",
  "spmxyqxjqxcyywkapong",
]);

export function isForbiddenProviderHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return ["supabase.co", "supabase.com", "supabase.in"].some(
    (apex) => normalized === apex || normalized.endsWith(`.${apex}`),
  );
}

export function isForbiddenProviderTarget(rawUrl: string): boolean {
  const normalized = rawUrl.trim().toLowerCase();
  return (
    isForbiddenProviderHost(urlHost(rawUrl)) ||
    FORBIDDEN_PROJECT_REFS.some((projectRef) => normalized.includes(projectRef))
  );
}

function urlHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export async function installNoHybridNetworkGate(context: BrowserContext) {
  const blocked = new Set<string>();

  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    if (isForbiddenProviderTarget(request.url())) {
      blocked.add(request.url());
      await route.abort("blockedbyclient");
      return;
    }

    const url = new URL(request.url());
    if (["127.0.0.1", "localhost"].includes(url.hostname) || ["blob:", "data:"].includes(url.protocol)) {
      await route.continue();
      return;
    }

    // Deterministic browser proof never calls a third-party provider.
    await route.abort("blockedbyclient");
  });

  await context.routeWebSocket("**/*", async (route: WebSocketRoute) => {
    const url = route.url();
    if (isForbiddenProviderTarget(url)) {
      blocked.add(url);
      await route.close({ code: 1008, reason: "No-hybrid provider block" });
      return;
    }

    if (["127.0.0.1", "localhost"].includes(urlHost(url))) {
      route.connectToServer();
      return;
    }

    // Never connect a deterministic browser proof to an unrelated provider.
    await route.close({ code: 1008, reason: "Third-party network disabled" });
  });

  return {
    blocked,
    assertClean() {
      if (blocked.size > 0) {
        throw new Error(
          `No-hybrid browser gate blocked provider requests:\n${[...blocked].sort().join("\n")}`,
        );
      }
    },
  };
}
