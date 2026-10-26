import { test, expect } from '@playwright/test';

test.describe('PlateDetect - App Principal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app', { state: 'visible' });
  });

  test('debe cargar la vista Home por defecto', async ({ page }) => {
    await expect(page.locator('#view-home')).toBeVisible();
    await expect(page.locator('h2')).toContainText('PlateDetect');
    await expect(page.locator('#btn-home-scan')).toBeVisible();
    await expect(page.locator('#btn-home-plates')).toBeVisible();
  });

  test('debe navegar a vista Patentes', async ({ page }) => {
    await page.click('#btn-home-plates');
    await expect(page.locator('#view-plates')).toBeVisible();
    await expect(page.locator('#view-plates h1')).toContainText('Patentes registradas');
    await expect(page.locator('#plate-search')).toBeVisible();
  });

  test('debe navegar a vista Cámara via bottom nav', async ({ page }) => {
    await page.click('nav >> text=Cámara');
    await expect(page.locator('#view-camera')).toBeVisible();
    await expect(page.locator('#video')).toBeVisible();
    // scan-toggle es un checkbox oculto, verificar el label
    await expect(page.locator('.switch-label')).toBeVisible();
  });

  test('debe navegar a vista Registro via bottom nav', async ({ page }) => {
    await page.click('nav >> text=Registro');
    await expect(page.locator('#view-register')).toBeVisible();
    await expect(page.locator('#view-register h1')).toContainText('Reportar Incidente');
    await expect(page.locator('#reg-plate')).toBeVisible();
  });

  test('debe navegar a vista Llamada via bottom nav', async ({ page }) => {
    await page.click('nav >> text=Llamada');
    await expect(page.locator('#view-call')).toBeVisible();
    await expect(page.locator('#view-call h1')).toContainText('Marcación Rápida');
    // contact-grid puede estar vacío inicialmente (sin contactos), verificar que existe
    await expect(page.locator('#contact-grid')).toBeAttached();
  });

  test('debe navegar a vista Acceso via bottom nav', async ({ page }) => {
    await page.click('nav >> text=Acceso');
    await expect(page.locator('#view-auth')).toBeVisible();
    await expect(page.locator('#auth-form-container')).toBeVisible();
  });

  test('debe mostrar diagnóstico en Home', async ({ page }) => {
    await expect(page.locator('#check-accordion')).toBeVisible();
    await expect(page.locator('#check-summary')).toBeVisible();
  });
});

test.describe('Navegación Bottom Nav', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.bottom-nav', { state: 'visible' });
  });

  test('debe cambiar vista activa al hacer click en nav items', async ({ page }) => {
    // Verificar estado inicial
    await expect(page.locator('#view-home')).toHaveClass(/active/);
    
    // Navegar a Cámara
    await page.click('[data-view="camera"]');
    await expect(page.locator('#view-camera')).toHaveClass(/active/);
    await expect(page.locator('#view-home')).not.toHaveClass(/active/);
    
    // Navegar a Registro
    await page.click('[data-view="register"]');
    await expect(page.locator('#view-register')).toHaveClass(/active/);
    
    // Navegar a Llamada
    await page.click('[data-view="call"]');
    await expect(page.locator('#view-call')).toHaveClass(/active/);
    
    // Volver a Home
    await page.click('[data-view="home"]');
    await expect(page.locator('#view-home')).toHaveClass(/active/);
  });

  test('debe resaltar item activo en bottom nav', async ({ page }) => {
    await expect(page.locator('[data-view="home"]')).toHaveClass(/active/);
    
    await page.click('[data-view="camera"]');
    await expect(page.locator('[data-view="camera"]')).toHaveClass(/active/);
    await expect(page.locator('[data-view="home"]')).not.toHaveClass(/active/);
  });
});