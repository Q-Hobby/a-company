import type { PortableImportBundle } from "@acompany/contracts";

/** Only reference a project that was actually selected into this archive. */
export function continuationInput(id: string, bundle: PortableImportBundle, sessionId: string) {
  const session = bundle.sessions.find((item) => item.id === sessionId);
  if (!session) return null;
  const project = bundle.projects.find((item) => item.id === session.projectId);
  return { id, sessionId: session.id, ...(project ? { projectId: project.id } : {}) };
}

/** Identity-based claims survive Strict Mode restarts without reviving old work. */
export function createArchiveRequestGate() {
  let current: AbortController | null = null;
  function invalidate() {
    current?.abort();
    current = null;
  }
  return {
    invalidate,
    begin(exclusive = false) {
      if (exclusive && current) return null;
      invalidate();
      const controller = new AbortController();
      current = controller;
      return {
        signal: controller.signal,
        isCurrent: () => current === controller,
        finish: () => {
          if (current === controller) current = null;
        },
      };
    },
  };
}
