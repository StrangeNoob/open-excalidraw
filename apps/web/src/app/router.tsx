/* eslint-disable react-refresh/only-export-components */
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
  useParams,
  type RouteObject,
} from "react-router-dom";
import { lazy, Suspense } from "react";

import {
  AuthProvider,
  ForgotPasswordPage,
  LoginPage,
  ResetPasswordPage,
  SignUpPage,
  useAuth,
  VerifyEmailNotice,
} from "../features/auth";

const DashboardPage = lazy(() =>
  import("../features/dashboard").then((module) => ({
    default: module.DashboardPage,
  })),
);
const GuestCanvasPage = lazy(() =>
  import("../features/guest/pages").then((module) => ({
    default: module.GuestCanvasPage,
  })),
);
const DrawingPage = lazy(() =>
  import("../features/workspace").then((module) => ({
    default: module.DrawingPage,
  })),
);
const AuthenticatedGuestMigrationPrompt = lazy(() =>
  import("../features/guest/components").then((module) => ({
    default: module.AuthenticatedGuestMigrationPrompt,
  })),
);
const InvitationPage = lazy(() =>
  import("../features/sharing").then((module) => ({
    default: module.InvitationPage,
  })),
);
const SharedDrawingRoute = lazy(() =>
  import("../features/sharing").then((module) => ({
    default: module.SharedDrawingRoute,
  })),
);
const SettingsPage = lazy(() =>
  import("../features/settings").then((module) => ({
    default: module.SettingsPage,
  })),
);

const AuthRouteLayout = () => (
  <AuthProvider>
    <Outlet />
  </AuthProvider>
);

const DashboardRoute = () => {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === "loading") {
    return <p aria-live="polite">Loading your account…</p>;
  }

  if (auth.status === "error") {
    return (
      <main>
        <h1>Could not load your account</h1>
        <button onClick={() => void auth.refresh()} type="button">
          Try again
        </button>
      </main>
    );
  }

  if (!auth.user) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return (
      <Navigate
        replace
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
      />
    );
  }

  return (
    <Suspense fallback={<p aria-live="polite">Loading your drawings…</p>}>
      <VerifyEmailNotice />
      <AuthenticatedGuestMigrationPrompt userId={auth.user.id} />
      <DashboardPage />
    </Suspense>
  );
};

const SettingsRoute = () => {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === "loading") {
    return <p aria-live="polite">Loading your account…</p>;
  }

  if (auth.status === "error") {
    return (
      <main>
        <h1>Could not load your account</h1>
        <button onClick={() => void auth.refresh()} type="button">
          Try again
        </button>
      </main>
    );
  }

  if (!auth.user) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return (
      <Navigate
        replace
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
      />
    );
  }

  return (
    <Suspense fallback={<p aria-live="polite">Loading settings…</p>}>
      <SettingsPage />
    </Suspense>
  );
};

const DrawingRoute = () => {
  const auth = useAuth();
  const location = useLocation();
  const { drawingId } = useParams();

  if (auth.status === "loading") {
    return <p aria-live="polite">Loading your account…</p>;
  }

  if (auth.status === "error") {
    return (
      <main>
        <h1>Could not load your account</h1>
        <button onClick={() => void auth.refresh()} type="button">
          Try again
        </button>
      </main>
    );
  }

  if (!auth.user) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return (
      <Navigate
        replace
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
      />
    );
  }

  if (!drawingId) {
    return <Navigate replace to="/app" />;
  }

  return (
    <Suspense fallback={<p aria-live="polite">Opening drawing…</p>}>
      <DrawingPage
        drawingId={drawingId}
        key={`${auth.user.id}:${drawingId}`}
        userId={auth.user.id}
      />
    </Suspense>
  );
};

export const appRoutes: RouteObject[] = [
  {
    path: "/",
    element: (
      <Suspense fallback={<p aria-live="polite">Loading the canvas…</p>}>
        <GuestCanvasPage />
      </Suspense>
    ),
  },
  {
    path: "/s/:token",
    element: (
      <Suspense fallback={<p aria-live="polite">Opening shared drawing…</p>}>
        <SharedDrawingRoute />
      </Suspense>
    ),
  },
  {
    element: <AuthRouteLayout />,
    children: [
      {
        path: "/login",
        element: <LoginPage />,
      },
      {
        path: "/signup",
        element: <SignUpPage />,
      },
      {
        path: "/forgot-password",
        element: <ForgotPasswordPage />,
      },
      {
        path: "/reset-password",
        element: <ResetPasswordPage />,
      },
      {
        path: "/invite/:token",
        element: (
          <Suspense fallback={<p aria-live="polite">Loading invitation…</p>}>
            <InvitationPage />
          </Suspense>
        ),
      },
      {
        path: "/app",
        element: <DashboardRoute />,
      },
      {
        path: "/app/settings",
        element: <SettingsRoute />,
      },
      {
        path: "/dashboard",
        element: <Navigate replace to="/app" />,
      },
      {
        path: "/drawings/:drawingId",
        element: <DrawingRoute />,
      },
    ],
  },
  {
    path: "*",
    element: <Navigate replace to="/" />,
  },
];

export const createAppRouter = () => createBrowserRouter(appRoutes);
