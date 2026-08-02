import type { SessionResponse } from "@open-excalidraw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { AuthClient } from "./auth-client";
import { AuthProvider } from "./AuthProvider";
import { OAuthConsentPage } from "./OAuthPages";

const session: SessionResponse = {
  capabilities: {
    emailPassword: true,
    github: false,
    google: false,
    oidc: false,
    oidcProviderName: "",
    signupsDisabled: false,
    smtp: false,
  },
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    email: "owner@example.test",
    name: "Owner",
    image: null,
    emailVerified: true,
    isAdmin: false,
    twoFactorEnabled: false,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
};

const authClient = {
  getSession: () => Promise.resolve(session),
} as unknown as AuthClient;

const renderConsent = (search: string) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider client={authClient}>
        <MemoryRouter initialEntries={[`/oauth/consent${search}`]}>
          <Routes>
            <Route element={<OAuthConsentPage />} path="/oauth/consent" />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
};

const WRITE_DESCRIPTION = /Create drawings, and change or delete anything/;
const READ_DESCRIPTION = /See your drawings and everything in them/;

describe("OAuth consent screen", () => {
  it("names the permissions a scoped request asks for", async () => {
    renderConsent("?consent_code=abc&client_id=client-1&scope=openid+read");

    expect(await screen.findByText(READ_DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(WRITE_DESCRIPTION)).not.toBeInTheDocument();
  });

  it("shows the write grant the server falls back to when none is named", async () => {
    // Approving a grant whose permissions were never displayed is the failure
    // this guards: the server reads a scopeless request as `write`.
    renderConsent("?consent_code=abc&client_id=client-1");

    expect(await screen.findByText(WRITE_DESCRIPTION)).toBeInTheDocument();
  });

  it("ignores protocol scopes that grant no access of their own", async () => {
    renderConsent(
      "?consent_code=abc&client_id=client-1&scope=openid+offline_access",
    );

    expect(await screen.findByText(WRITE_DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(READ_DESCRIPTION)).not.toBeInTheDocument();
  });
});
