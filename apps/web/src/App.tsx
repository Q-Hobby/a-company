import { LOCAL_SETTINGS_PAGE } from "@acompany/contracts";
import { lazy, type ReactNode, Suspense, useLayoutEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { authClient } from "./lib/auth";
import { markAfterPaint, markOnce } from "./lib/performance";
import { rememberPostAuthReturnPath } from "./lib/post-auth-redirect";
import { AuthPage, PasswordResetPage } from "./pages/Auth";
import { IntegrationSetupPage } from "./pages/IntegrationSetup";
import { LocalSettingsPage } from "./pages/LocalSettings";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { ShellPage } from "./pages/Shell";
import { WelcomePage } from "./pages/Welcome";

const OnboardingPage = lazy(() =>
  import("./pages/Onboarding").then((module) => ({ default: module.OnboardingPage })),
);

const accountlessMode = import.meta.env.VITE_ACCOUNTLESS_MODE === "true";

export function App() {
  if (window.location.pathname === LOCAL_SETTINGS_PAGE) return <LocalSettingsPage />;
  if (accountlessMode) return <AccountlessWorkspaceApp />;
  return <AuthenticatedWorkspaceApp />;
}

function AccountlessWorkspaceApp() {
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

function AuthenticatedWorkspaceApp() {
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session?.user);

  useLayoutEffect(() => {
    if (isPending) return;
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, [isPending]);

  if (isPending) {
    return <div className="h-full bg-background" data-acompany-app-state="session-pending" />;
  }

  return (
    <div className="h-full" data-acompany-app-state="ready">
      <Suspense fallback={<div className="h-full bg-background" />}>
        <Routes>
          <Route
            path="/"
            element={
              signedIn ? (
                <Navigate to="/app" replace />
              ) : window.acompanyDesktop ? (
                <Navigate to="/sign-in" replace />
              ) : (
                <WelcomePage />
              )
            }
          />
          <Route
            path="/sign-in"
            element={signedIn ? <Navigate to="/app" replace /> : <AuthPage mode="in" />}
          />
          <Route
            path="/sign-up"
            element={signedIn ? <Navigate to="/onboarding" replace /> : <AuthPage mode="up" />}
          />
          <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
          <Route path="/reset-password" element={<PasswordResetPage />} />
          <Route
            path="/onboarding"
            element={
              <RequireAuth signedIn={signedIn}>
                <OnboardingPage />
              </RequireAuth>
            }
          />
          <Route path="/mcp/oauth/callback" element={<McpOAuthCallbackPage />} />
          <Route
            path="/integrations/setup"
            element={
              <RequireAuth signedIn={signedIn}>
                <IntegrationSetupPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app"
            element={
              <RequireAuth signedIn={signedIn}>
                <ShellPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/g/:groupId"
            element={
              <RequireAuth signedIn={signedIn}>
                <ShellPage />
              </RequireAuth>
            }
          />
          <Route
            path="/app/:botId"
            element={
              <RequireAuth signedIn={signedIn}>
                <ShellPage />
              </RequireAuth>
            }
          />
        </Routes>
      </Suspense>
    </div>
  );
}

function RequireAuth({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  const location = useLocation();
  if (!signedIn) {
    rememberPostAuthReturnPath(location.pathname, location.search);
    return <Navigate to="/sign-in" replace />;
  }
  return <>{children}</>;
}
