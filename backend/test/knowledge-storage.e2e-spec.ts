import { KnowledgeStorageService } from '../src/knowledge/knowledge-storage.service';

describe('private knowledge object storage', () => {
  const values: Record<string, string> = {
    KNOWLEDGE_STORAGE_PROVIDER: 'r2',
    R2_ACCOUNT_ID: 'account',
    R2_ACCESS_KEY_ID: 'ACCESS',
    R2_SECRET_ACCESS_KEY: 'SECRET',
    KNOWLEDGE_R2_BUCKET: 'private-knowledge',
    KNOWLEDGE_R2_ENDPOINT: 'https://storage.test',
  };
  const service = () =>
    new KnowledgeStorageService({ get: (key: string) => values[key] } as never);

  afterEach(() => jest.restoreAllMocks());

  it('uses signed private PUT/GET/DELETE requests and returns only an object key', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('policy text'), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const storage = service();

    const key = await storage.save('org-a', 'doc-1', 'policy.pdf', Buffer.from('%PDF'));
    expect(key).toBe('org/org-a/doc-1/policy.pdf');
    expect(key).not.toContain('http');
    await expect(storage.read('org-a', key)).resolves.toEqual(Buffer.from('policy text'));
    await expect(storage.remove('org-a', key)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'GET', 'DELETE']);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: expect.stringContaining('AWS4-HMAC-SHA256') }));
    }
  });

  it('refuses cross-organisation object keys before making a network call', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    await expect(service().read('org-b', 'org/org-a/doc-1/policy.pdf')).rejects.toThrow(
      'does not belong to this organisation',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when private R2 is selected but incomplete', async () => {
    const storage = new KnowledgeStorageService({
      get: (key: string) => (key === 'KNOWLEDGE_STORAGE_PROVIDER' ? 'r2' : ''),
    } as never);
    await expect(storage.save('org-a', 'doc-1', 'policy.txt', Buffer.from('x'))).rejects.toThrow(
      'requires R2 account credentials',
    );
  });
});
