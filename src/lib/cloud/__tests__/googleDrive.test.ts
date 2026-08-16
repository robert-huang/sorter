import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleDriveProvider,
  buildGoogleOAuthAuthorizationUrl,
} from '../googleDrive';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    'sorter:cloud:tokens:v1',
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
    }),
  );
  localStorage.setItem(
    'sorter:cloud:folder:v1',
    JSON.stringify({ folderId: 'folder-1', folderName: 'Backups' }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Google Drive OAuth', () => {
  it('forces account selection while retaining consent for refresh tokens', () => {
    const url = new URL(
      buildGoogleOAuthAuthorizationUrl({
        clientId: 'client-id',
        redirectUrl: 'https://sorter.example.com/',
        challenge: 'pkce-challenge',
        state: 'oauth-state',
      }),
    );

    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('GoogleDriveProvider.listCloudSlots', () => {
  it('follows page tokens while preserving API order and existing metadata mapping', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                id: 'file-1',
                name: 'First.sorter.json',
                modifiedTime: '2026-08-01T01:00:00.000Z',
                size: '100',
                md5Checksum: 'md5-1',
                appProperties: {
                  sorterDisplayName: 'First',
                  sorterSlotId: 'slot-1',
                  sorterDone: 'true',
                },
              },
              {
                id: 'file-2',
                name: 'Second.sorter.json',
                modifiedTime: '2026-08-01T02:00:00.000Z',
                size: '200',
                version: 'version-2',
              },
            ],
            nextPageToken: 'page-2',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                id: 'file-2',
                name: 'Duplicate.sorter.json',
                modifiedTime: '2026-08-01T02:00:00.000Z',
              },
              {
                id: 'file-3',
                name: 'Third.sorter.json',
                modifiedTime: '2026-08-01T03:00:00.000Z',
                size: '300',
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const slots = await new GoogleDriveProvider().listCloudSlots();

    expect(slots.map((slot) => slot.cloudId)).toEqual([
      'file-1',
      'file-2',
      'file-3',
    ]);
    expect(slots[0]).toMatchObject({
      displayName: 'First',
      sizeBytes: 100,
      etag: 'md5-1',
      sorterSlotId: 'slot-1',
      done: true,
    });
    expect(slots[1]?.etag).toBe('version-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchMock.mock.calls[0]?.[0].toString() ?? '');
    const secondUrl = new URL(fetchMock.mock.calls[1]?.[0].toString() ?? '');
    expect(firstUrl.searchParams.get('fields')).toContain('nextPageToken');
    expect(firstUrl.searchParams.has('pageToken')).toBe(false);
    expect(secondUrl.searchParams.get('pageToken')).toBe('page-2');
  });

  it('stops when Google Drive repeats a page token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ files: [], nextPageToken: 'repeated-token' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ files: [], nextPageToken: 'repeated-token' }),
          { status: 200 },
        ),
      );

    await expect(
      new GoogleDriveProvider().listCloudSlots(),
    ).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
