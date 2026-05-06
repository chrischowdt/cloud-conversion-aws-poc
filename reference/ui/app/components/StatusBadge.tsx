import React from 'react';
import { Chip } from '@dynatrace/strato-components/content';

import type { ConnectionStatus } from '../types/connection';

const STATUS_COLOR_MAP: Record<ConnectionStatus, 'warning' | 'success' | 'primary'> = {
  Classic: 'warning',
  New: 'success',
  Parallel: 'primary',
};

export const StatusBadge = ({ status }: { status: ConnectionStatus }) => (
  <Chip color={STATUS_COLOR_MAP[status]} size="condensed">
    {status}
  </Chip>
);
