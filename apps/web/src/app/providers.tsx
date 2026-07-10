import {
  QueryClient,
  QueryClientProvider,
  type QueryClientConfig,
} from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

const defaultQueryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
    mutations: {
      retry: false,
    },
  },
};

// The client factory is intentionally colocated with its provider.
// eslint-disable-next-line react-refresh/only-export-components
export const createAppQueryClient = (
  config: QueryClientConfig = defaultQueryClientConfig,
) => new QueryClient(config);

type AppProvidersProps = PropsWithChildren<{
  queryClient: QueryClient;
}>;

export const AppProviders = ({ children, queryClient }: AppProvidersProps) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
