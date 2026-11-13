import { LOCAL_SETTINGS_PAGE } from "@acompany/contracts";
import { lazy, Suspense, useLayoutEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { markAfterPaint, markOnce } from "./lib/performance";
import { IntegrationSetupPage } from "./pages/IntegrationSetup";
import { LocalSettingsPage } from "./pages/LocalSettings";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { ShellPage } from "./pages/Shell";

const OnboardingPage = lazy(() =>
  import("./pages/Onboarding").then((module) => ({ default: module.OnboardingPage })),
);

export function App() {
  if (window.location.pathname === LOCAL_SETTINGS_PAGE) return <LocalSettingsPage />;
  return <WorkspaceApp />;
}

function WorkspaceApp() {
  useLayoutEffect(() => {
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, []);

  return (
    <div className="h-full" data-acompany-app-state="ready">
      <Suspense fallback={<div className="h-full bg-background" />}>
        <Routes>
          <Route path="/" element={<Navigate to="/app" replace />} />
          <Route path="/sign-in" element={<Navigate to="/app" replace />} />
          <Route path="/sign-up" element={<Navigate to="/app" replace />} />
          <Route path="/forgot-password" element={<Navigate to="/app" replace />} />
          <Route path="/reset-password" element={<Navigate to="/app" replace />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/mcp/oauth/callback" element={<McpOAuthCallbackPage />} />
          <Route path="/integrations/setup" element={<IntegrationSetupPage />} />
          <Route path="/app" element={<ShellPage />} />
          <Route path="/app/g/:groupId" element={<ShellPage />} />
          <Route path="/app/:botId" element={<ShellPage />} />
        </Routes>
      </Suspense>
    </div>
  );
}
