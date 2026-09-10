import { AuditService, type AuditEvent } from '../src/common/audit.service';
import type { AuthUser } from '../src/common/auth-user';

const EVENT: AuditEvent = {
  action: 'store.auto_detected',
  entityType: 'store',
  entityId: 'store-a',
  storeId: 'store-a',
  summary: 'Detected a branch from a connector',
};

const MACHINE: AuthUser = {
  id: 'agent:agent-a',
  agentId: 'agent-a',
  name: 'Back-office connector',
  email: '',
  role: 'head_office',
  organisationId: 'org-a',
  storeIds: [],
  allStores: true,
  isMachine: true,
  connectorSourceSystem: 'gati',
};

describe('machine audit identity', () => {
  it('records a Connect agent without inventing a human User foreign key', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'audit-a' });
    const service = new AuditService({ auditLog: { create } } as never);

    await service.record(MACHINE, EVENT);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organisationId: 'org-a',
        actorId: null,
        machineActorId: 'agent-a',
        actorName: 'Back-office connector',
        action: EVENT.action,
      }),
    });
  });

  it('makes an audit failure abort a caller-supplied ingestion transaction', async () => {
    const failure = new Error('audit storage unavailable');
    const transactionCreate = jest.fn().mockRejectedValue(failure);
    const service = new AuditService({ auditLog: { create: jest.fn() } } as never);

    await expect(
      service.record(MACHINE, EVENT, {
        auditLog: { create: transactionCreate },
      } as never),
    ).rejects.toBe(failure);
  });

  it('keeps a human actor on the existing User relation', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'audit-human' });
    const service = new AuditService({ auditLog: { create } } as never);
    const human: AuthUser = {
      ...MACHINE,
      id: 'user-a',
      agentId: undefined,
      isMachine: false,
      email: 'owner@example.test',
    };

    await service.record(human, EVENT);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'user-a',
        machineActorId: null,
      }),
    });
  });
});
