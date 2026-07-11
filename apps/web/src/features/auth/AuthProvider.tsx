import {
  type AuthCapabilities,
  type SessionResponse,
} from "@open-excalidraw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CookieAuthClient,
  type AuthClient,
  type EmailSignInInput,
  type EmailSignUpInput,
  type OAuthProvider,
} from "./auth-client";
import { purgeProtectedState } from "./protected-state";

const NO_AUTH_CAPABILITIES: AuthCapabilities = {
  emailPassword: false,
  github: false,
  google: false,
  smtp: false,
};

export type AuthStatus = "error" | "loading" | "ready";

export interface AuthContextValue {
  capabilities: AuthCapabilities;
  logout(): Promise<void>;
  refresh(): Promise<SessionResponse>;
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  resendVerification(email: string, callbackURL: string): Promise<void>;
  resetPassword(newPassword: string, token: string): Promise<void>;
  signIn(input: EmailSignInInput): Promise<SessionResponse>;
  signUp(input: EmailSignUpInput): Promise<SessionResponse>;
  startOAuth(provider: OAuthProvider, returnPath: string): Promise<void>;
  status: AuthStatus;
  user: SessionResponse["user"];
}

const AuthContext = createContext<AuthContextValue | null>(null);
const defaultAuthClient = new CookieAuthClient();

export interface AuthProviderProps extends PropsWithChildren {
  client?: AuthClient;
}

export const AuthProvider = ({
  children,
  client = defaultAuthClient,
}: AuthProviderProps) => {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<SessionResponse>({
    capabilities: NO_AUTH_CAPABILITIES,
    user: null,
  });
  const [status, setStatus] = useState<AuthStatus>("loading");
  const sessionRequestVersion = useRef(0);

  const refresh = useCallback(async () => {
    const requestVersion = ++sessionRequestVersion.current;
    try {
      const nextSession = await client.getSession();
      if (requestVersion === sessionRequestVersion.current) {
        setSession(nextSession);
        setStatus("ready");
      }
      return nextSession;
    } catch (error) {
      if (requestVersion === sessionRequestVersion.current) {
        setStatus("error");
      }
      throw error;
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    const requestVersion = ++sessionRequestVersion.current;

    void client
      .getSession()
      .then((nextSession) => {
        if (active && requestVersion === sessionRequestVersion.current) {
          setSession(nextSession);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (active && requestVersion === sessionRequestVersion.current) {
          setStatus("error");
        }
      });

    return () => {
      active = false;
    };
  }, [client]);

  const signIn = useCallback(
    async (input: EmailSignInInput) => {
      await client.signIn(input);
      return refresh();
    },
    [client, refresh],
  );

  const signUp = useCallback(
    async (input: EmailSignUpInput) => {
      await client.signUp(input);
      return refresh();
    },
    [client, refresh],
  );

  const logout = useCallback(async () => {
    sessionRequestVersion.current += 1;
    let signOutError: unknown;

    try {
      await client.signOut();
    } catch (error) {
      signOutError = error;
    }

    await queryClient.cancelQueries();
    queryClient.clear();
    await purgeProtectedState();
    setSession((current) => ({
      capabilities: current.capabilities,
      user: null,
    }));
    setStatus("ready");

    if (signOutError instanceof Error) {
      throw signOutError;
    }

    if (signOutError) {
      throw new Error("The server could not complete sign out.");
    }
  }, [client, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      capabilities: session.capabilities,
      logout,
      refresh,
      requestPasswordReset: (email, redirectTo) =>
        client.requestPasswordReset(email, redirectTo),
      resendVerification: (email, callbackURL) =>
        client.resendVerification(email, callbackURL),
      resetPassword: (newPassword, token) =>
        client.resetPassword(newPassword, token),
      signIn,
      signUp,
      startOAuth: (provider, returnPath) =>
        client.startOAuth(provider, returnPath),
      status,
      user: session.user,
    }),
    [client, logout, refresh, session, signIn, signUp, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = (): AuthContextValue => {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return value;
};
