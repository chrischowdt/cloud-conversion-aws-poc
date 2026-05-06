import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@dynatrace/strato-components-testing/jest';

import { useCloudAccountInventory } from '../hooks/useConnectionInventory';
import { Inventory } from './Inventory';
import type { CloudAccount } from '../types/connection';
import type { CloudAccountInventory } from '../hooks/useConnectionInventory';

// ─── Module mock ─────────────────────────────────────────────────────────────

jest.mock('../hooks/useConnectionInventory');

const mockUseCloudAccountInventory = useCloudAccountInventory as jest.MockedFunction<
  typeof useCloudAccountInventory
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<CloudAccount> = {}): CloudAccount {
  return {
    provider: 'AWS',
    name: 'Test Account',
    accountId: '123456789012',
    status: 'Classic',
    entityId: 'AWS_CRED-1',
    subscriptionEntityId: null,
    hasDuplicateAccountId: false,
    isMigrationBlocked: false,
    ...overrides,
  };
}

function makeInventoryState(overrides: Partial<CloudAccountInventory> = {}): CloudAccountInventory {
  return {
    accounts: [],
    isLoading: false,
    aws: { data: null, isLoading: false, error: null },
    azure: { data: null, isLoading: false, error: null },
    gcp: { data: null, isLoading: false, error: null },
    refetch: jest.fn(),
    ...overrides,
  };
}

function renderInventory() {
  return render(<Inventory />, { wrapper: MemoryRouter });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Inventory page', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('loading state', () => {
    it('does not show account names while loading', () => {
      mockUseCloudAccountInventory.mockReturnValue(
        makeInventoryState({ isLoading: true, accounts: [] })
      );

      renderInventory();

      expect(screen.queryByText('My Classic Account')).not.toBeInTheDocument();
    });
  });

  describe('populated state', () => {
    it('renders a row for each account', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ provider: 'AWS', name: 'Prod AWS', accountId: '111111111111', status: 'Classic' }),
        makeAccount({ provider: 'Azure', name: 'Prod Azure', accountId: 'sub-uuid-1', status: 'New', entityId: null }),
        makeAccount({ provider: 'GCP', name: 'Prod GCP', accountId: 'my-gcp-project', status: 'Parallel' }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('Prod AWS')).toBeInTheDocument();
        expect(screen.getByText('Prod Azure')).toBeInTheDocument();
        expect(screen.getByText('Prod GCP')).toBeInTheDocument();
      });
    });

    it('renders the correct status badge label for each account', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'Classic Account', status: 'Classic', entityId: 'AWS_CRED-1' }),
        makeAccount({ name: 'New Account', status: 'New', entityId: null }),
        makeAccount({ name: 'Parallel Account', status: 'Parallel', entityId: 'AWS_CRED-3' }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('Classic')).toBeInTheDocument();
        expect(screen.getByText('New')).toBeInTheDocument();
        expect(screen.getByText('Parallel')).toBeInTheDocument();
      });
    });

    it('renders account ID in the table', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'My Account', accountId: '999888777666' }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('999888777666')).toBeInTheDocument();
      });
    });

    it('renders a — placeholder for Azure accounts with null accountId', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ provider: 'Azure', name: 'Legacy Azure', accountId: null, status: 'Classic' }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('—')).toBeInTheDocument();
      });
    });

    it('renders a warning icon tooltip for duplicate AWS account IDs', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'Cred One', accountId: '444444444444', hasDuplicateAccountId: true }),
        makeAccount({ name: 'Cred Two', accountId: '444444444444', hasDuplicateAccountId: true, entityId: 'AWS_CRED-2' }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('Cred One')).toBeInTheDocument();
        expect(screen.getByText('Cred Two')).toBeInTheDocument();
      });

      // Both rows share the same account ID — WarningIcon should appear for each
      const warningIcons = document.querySelectorAll('[data-iconname="WarningIcon"]');
      expect(warningIcons.length).toBeGreaterThanOrEqual(2);
    });

    it('renders a link on each account name that points to /inventory/:accountId', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'Linked Account', accountId: '123456789012' }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        const link = screen.getByRole('link', { name: 'Linked Account' });
        expect(link).toHaveAttribute('href', '/inventory/123456789012');
      });
    });

    it('does not render a link for New-only accounts', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'New Account', status: 'New', entityId: null }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('New Account')).toBeInTheDocument();
      });

      expect(screen.queryByRole('link', { name: 'New Account' })).not.toBeInTheDocument();
    });

    it('renders a "No migration needed" chip for New accounts', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'New Account', status: 'New', entityId: null }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('No migration needed')).toBeInTheDocument();
      });
    });

    it('does not render a "No migration needed" chip for Classic accounts', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'Classic Account', status: 'Classic' }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('Classic Account')).toBeInTheDocument();
      });

      expect(screen.queryByText('No migration needed')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows the EmptyState component when all queries finish with no accounts', async () => {
      mockUseCloudAccountInventory.mockReturnValue(
        makeInventoryState({ accounts: [], isLoading: false })
      );

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('No cloud connections found')).toBeInTheDocument();
      });
    });

    it('does not show the EmptyState while loading', () => {
      mockUseCloudAccountInventory.mockReturnValue(
        makeInventoryState({ accounts: [], isLoading: true })
      );

      renderInventory();

      expect(screen.queryByText('No cloud connections found')).not.toBeInTheDocument();
    });
  });

  describe('per-provider error banners', () => {
    it('shows a warning banner for each provider that errored', async () => {
      mockUseCloudAccountInventory.mockReturnValue(
        makeInventoryState({
          accounts: [],
          aws: { data: null, isLoading: false, error: new Error('AWS error') },
          azure: { data: null, isLoading: false, error: new Error('Azure error') },
          gcp: { data: null, isLoading: false, error: null },
        })
      );

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText(/Could not load AWS connections/)).toBeInTheDocument();
        expect(screen.getByText(/Could not load Azure connections/)).toBeInTheDocument();
        expect(screen.queryByText(/Could not load GCP connections/)).not.toBeInTheDocument();
      });
    });

    it('does not show error banners when all providers succeed', () => {
      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts: [] }));

      renderInventory();

      expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
    });
  });

  describe('migration blocked indicator', () => {
    it('renders a "Migration blocked" chip in the Status cell for a blocked AWS account', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'Streams Account', status: 'Classic', isMigrationBlocked: true }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('Streams Account')).toBeInTheDocument();
        expect(screen.getByText('Migration blocked')).toBeInTheDocument();
      });
    });

    it('does not render a "Migration blocked" chip for a non-blocked account', async () => {
      const accounts: CloudAccount[] = [
        makeAccount({ name: 'Polling Account', status: 'Classic', isMigrationBlocked: false }),
      ];

      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts }));

      renderInventory();

      await waitFor(() => {
        expect(screen.getByText('Polling Account')).toBeInTheDocument();
      });

      expect(screen.queryByText('Migration blocked')).not.toBeInTheDocument();
    });
  });

  describe('timeframe display', () => {
    it('shows the default timeframe label in the heading area', () => {
      mockUseCloudAccountInventory.mockReturnValue(makeInventoryState({ accounts: [] }));

      renderInventory();

      expect(screen.getByText(/last 12 hours/)).toBeInTheDocument();
    });
  });
});
