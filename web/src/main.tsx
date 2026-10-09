import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SelectionProvider } from './lib/selection';
import { CampaignDetailPage } from './pages/CampaignDetail';
import { CampaignsPage } from './pages/Campaigns';
import { CompaniesPage } from './pages/Companies';
import { ContactsPage } from './pages/Contacts';
import { DashboardPage } from './pages/Dashboard';
import { DiscoverPage } from './pages/Discover';
import { HistoryPage } from './pages/History';
import { NewCampaignPage } from './pages/NewCampaign';
import { SettingsPage } from './pages/Settings';
import { TemplatesPage } from './pages/Templates';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SelectionProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<DashboardPage />} />
              <Route path="discover" element={<DiscoverPage />} />
              <Route path="companies" element={<CompaniesPage />} />
              <Route path="companies/:id" element={<CompaniesPage />} />
              <Route path="contacts" element={<ContactsPage />} />
              <Route path="templates" element={<TemplatesPage />} />
              <Route path="templates/:id" element={<TemplatesPage />} />
              <Route path="campaigns" element={<CampaignsPage />} />
              <Route path="campaigns/new" element={<NewCampaignPage />} />
              <Route path="campaigns/:id" element={<CampaignDetailPage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<div className="p-8 text-slate-500">Page not found.</div>} />
            </Route>
          </Routes>
        </BrowserRouter>
      </SelectionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
