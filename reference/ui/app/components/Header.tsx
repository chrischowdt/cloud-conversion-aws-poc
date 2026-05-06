import React from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "@dynatrace/strato-components-preview/layouts";

export const Header = () => {
  return (
    <AppHeader>
      <AppHeader.NavItems>
        <AppHeader.AppNavLink as={Link} to="/inventory" />
        <AppHeader.NavItem as={Link} to="/inventory">
          Cloud Accounts
        </AppHeader.NavItem>
        <AppHeader.NavItem as={Link} to="/readiness">
          Migration Assessment
        </AppHeader.NavItem>
      </AppHeader.NavItems>
    </AppHeader>
  );
};
