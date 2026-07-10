/* eslint-disable react-refresh/only-export-components */
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
  type RouteObject,
} from "react-router-dom";
import { lazy, Suspense } from "react";

import { AuthProvider, LoginPage, SignUpPage, useAuth } from "../features/auth";
import { App } from "./App";

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
      <DashboardPage />
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
        path: "/app",
        element: <DashboardRoute />,
      },
      {
        path: "/dashboard",
        element: <Navigate replace to="/app" />,
      },
      {
        path: "/drawings/:drawingId",
        element: <App />,
      },
    ],
  },
  {
    path: "*",
    element: <Navigate replace to="/" />,
  },
];

export const createAppRouter = () => createBrowserRouter(appRoutes);
