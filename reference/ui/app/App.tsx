import { Page } from "@dynatrace/strato-components-preview/layouts";
import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ToastContainer } from "@dynatrace/strato-components/notifications";
import { Header } from "./components/Header";
import { TokenProvider } from "./context/TokenContext";
import { AccountDetail } from "./pages/AccountDetail";
import { Inventory } from "./pages/Inventory";import { Readiness } from './pages/Readiness';
export const App = () => {
  return (
    <TokenProvider>
      <ToastContainer />
      <Page>
        <Page.Header>
          <Header />
        </Page.Header>
        <Page.Main>
          <Routes>
            <Route index element={<Navigate to="/inventory" replace />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/inventory/:accountId" element={<AccountDetail />} />
            <Route path="/readiness" element={<Readiness />} />
          </Routes>
        </Page.Main>
      </Page>
    </TokenProvider>
  );
};
