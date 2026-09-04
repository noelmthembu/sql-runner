import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'related.sqlite');

async function uploadRelatedDatabase(page: Page) {
  const uploadRequests: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PUT', 'PATCH'].includes(request.method())) uploadRequests.push(request.url());
  });

  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await expect(page.getByTestId('button-table-customers')).toBeVisible();
  await expect(page.getByTestId('button-table-orders')).toBeVisible();

  return uploadRequests;
}

test.describe('uploaded SQLite databases', () => {
  test('stays local, discovers related tables, runs a join, and renders rows', async ({ page }) => {
    const uploadRequests = await uploadRelatedDatabase(page);

    await expect(page.getByTestId('column-customers-id')).toBeVisible();
    await expect(page.getByTestId('column-customers-name')).toBeVisible();
    await page.getByTestId('button-table-orders').click();
    await expect(page.getByTestId('column-orders-customer_id')).toBeVisible();
    await expect(page.getByTestId('column-orders-total')).toBeVisible();
    expect(uploadRequests).toEqual([]);

    await page.getByTestId('input-sql-query').fill(`
      SELECT c.name AS customer_name, o.status, o.total
      FROM customers AS c
      JOIN orders AS o ON o.customer_id = c.id
      ORDER BY c.id;
    `);
    await page.getByTestId('button-run-query').click();

    await expect(page.getByTestId('status-query-result')).toContainText('Success');
    await expect(page.getByTestId('row-result-0')).toContainText('Ada Lovelace');
    await expect(page.getByTestId('row-result-0')).toContainText('paid');
    await expect(page.getByTestId('row-result-1')).toContainText('Grace Hopper');
  });

  test('blocks mutations and multi-statement input with the blocked-query error', async ({ page }) => {
    await uploadRelatedDatabase(page);
    const queryInput = page.getByTestId('input-sql-query');
    const runButton = page.getByTestId('button-run-query');
    const blockedError = page.getByTestId('status-query-error');

    for (const query of [
      "INSERT INTO customers (id, name) VALUES (99, 'Intruder')",
      "UPDATE customers SET name = 'Changed' WHERE id = 1",
      'DELETE FROM customers WHERE id = 1',
      'SELECT * FROM customers; SELECT * FROM orders',
    ]) {
      await queryInput.fill(query);
      await runButton.click();
      await expect(blockedError).toContainText('That statement is blocked. The runner accepts one safe SELECT query only.');
    }
  });

  test('keeps the uploaded result view available in compact embed mode', async ({ page }) => {
    await uploadRelatedDatabase(page);
    await page.getByTestId('input-sql-query').fill('SELECT * FROM customers ORDER BY id;');
    await page.getByTestId('button-run-query').click();
    await expect(page.getByTestId('status-query-result')).toContainText('Success');
    await expect(page.getByTestId('row-result-0')).toContainText('Ada Lovelace');

    await page.getByTestId('button-compact-mode').click();

    await expect(page).toHaveURL(/[?&]embed=1/);
    await expect(page.locator('.runner-shell.compact-mode')).toBeVisible();
    await expect(page.getByTestId('row-result-0')).toContainText('Ada Lovelace');
    await expect(page.getByTestId('button-compact-upload')).toBeVisible();
  });
});