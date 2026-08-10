import { test, expect } from './fixtures.js';

/**
 * The Import dialog's "Sample source" list belongs to the user: a shipped sample
 * that is no use here can be deleted, and the URL somebody imports from every
 * week can be added to it. It survives a reload, because it is stored in the
 * workspace settings rather than held in the dialog.
 */

const openImport = async (page: import('@playwright/test').Page) => {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
};

const sampleLabels = async (dlg: import('@playwright/test').Locator) => (await dlg.getByTestId('import-sample').locator('option').allTextContents()).map((s) => s.trim());

test('a URL can be added to the samples, and it comes back after a reload', async ({ page }) => {
  let dlg = await openImport(page);

  // The + is disabled until there is a URL to keep, and it sits next to the box
  // it acts on.
  await expect(dlg.getByTestId('sample-add')).toBeDisabled();
  await dlg.locator('input[type="text"]').first().fill('https://example.test/weekly.csv');
  await dlg.getByTestId('import-format').selectOption('csv');
  await expect(dlg.getByTestId('sample-add')).toHaveText('+');
  await expect(dlg.getByTestId('sample-add')).toBeEnabled();

  // Naming it is a prompt — the label is what the dropdown will show.
  await dlg.getByTestId('sample-add').click();
  const prompt = page.locator('host-dialogs dialog');
  await expect(prompt).toBeVisible();
  await prompt.locator('input').fill('Weekly figures');
  await prompt.getByRole('button', { name: 'OK' }).click();

  // It is in the list, under a heading that separates it from ours.
  await expect(dlg.getByTestId('import-sample')).toContainText('Weekly figures');
  await expect(dlg.getByTestId('import-sample').locator('optgroup')).toHaveCount(2);

  // Reload: the sample is stored in the workspace, not in the dialog.
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  dlg = await openImport(page);
  await expect(dlg.getByTestId('import-sample')).toContainText('Weekly figures');

  // Picking it fills the URL box and the format it was saved with.
  await dlg.getByTestId('import-sample').selectOption({ label: 'Weekly figures' });
  await expect(dlg.locator('input[type="text"]').first()).toHaveValue('https://example.test/weekly.csv');
  await expect(dlg.getByTestId('import-format')).toHaveValue('csv');
});

test('a shipped sample can be deleted and every deletion undone', async ({ page }) => {
  let dlg = await openImport(page);
  const before = await sampleLabels(dlg);
  const victim = before.find((l) => l.startsWith('Northwind'));
  expect(victim).toBeTruthy();

  // The trash needs a sample picked — there is nothing to delete otherwise.
  await expect(dlg.getByTestId('sample-delete')).toBeDisabled();
  await dlg.getByTestId('import-sample').selectOption({ label: victim! });
  await expect(dlg.getByTestId('sample-delete')).toBeEnabled();

  await dlg.getByTestId('sample-delete').click();
  const confirm = page.locator('host-dialogs dialog');
  await expect(confirm).toContainText('Delete the sample');
  await confirm.getByRole('button', { name: 'Yes' }).click();

  await expect(dlg.getByTestId('import-sample')).not.toContainText('Northwind');
  // The URL it filled in stays in the box — deleting a sample is not undoing a pick.
  await expect(dlg.locator('input[type="text"]').first()).toHaveValue(/northwind/);

  // Survives a reload…
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  dlg = await openImport(page);
  await expect(dlg.getByTestId('import-sample')).not.toContainText('Northwind');

  // …and "Restore samples" brings back everything that was deleted.
  await expect(dlg.getByTestId('sample-restore')).toBeVisible();
  await dlg.getByTestId('sample-restore').click();
  await expect(dlg.getByTestId('sample-restore')).toHaveCount(0);
  expect(await sampleLabels(dlg)).toEqual(before);
});
