import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './lib/api';
import { createAppRouter } from './router';
import './styles.css';

const routerRef: { current?: ReturnType<typeof createAppRouter> } = {};

/**
 * A 401 on any request (session expired or revoked) sends the user to the login page and
 * back to where they were afterwards. The session query itself is handled by the route guard.
 */
const onUnauthorized = (err: unknown) => {
  const router = routerRef.current;
  if (!(err instanceof ApiError) || err.status !== 401 || !router) return;
  const { pathname, href } = router.state.location;
  if (pathname === '/login') return;
  queryClient.removeQueries({ queryKey: ['session'] });
  void router.navigate({ to: '/login', search: pathname === '/' ? {} : { next: href } });
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (query.queryKey[0] !== 'session') onUnauthorized(err);
    },
  }),
  mutationCache: new MutationCache({ onError: onUnauthorized }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
    // Mutations are never retried automatically: issuing an invoice must be a deliberate act.
    mutations: { retry: false },
  },
});

const router = createAppRouter(queryClient);
routerRef.current = router;

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
