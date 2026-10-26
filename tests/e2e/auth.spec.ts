import { test, expect } from '@playwright/test';

test.describe('Auth Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app', { state: 'visible' });
  });

  test('debe mostrar formulario de login en vista Acceso', async ({ page }) => {
    await page.click('[data-view="auth"]');
    await expect(page.locator('#view-auth')).toBeVisible();
    await expect(page.locator('#auth-form-container')).toBeVisible();
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect(page.locator('#auth-password')).toBeVisible();
    await expect(page.locator('button:has-text("Entrar")')).toBeVisible();
  });

  test('debe permitir cambiar a registro', async ({ page }) => {
    await page.click('[data-view="auth"]');
    await expect(page.locator('button:has-text("Crear cuenta")')).toBeVisible();
    
    await page.click('button:has-text("Crear cuenta")');
    await expect(page.locator('#reg-name')).toBeVisible();
    await expect(page.locator('#reg-email')).toBeVisible();
    await expect(page.locator('#reg-password')).toBeVisible();
    await expect(page.locator('#reg-confirm')).toBeVisible();
    await expect(page.locator('button:has-text("Registrarse")')).toBeVisible();
  });

  test('debe permitir volver a login desde registro', async ({ page }) => {
    await page.click('[data-view="auth"]');
    await page.click('button:has-text("Crear cuenta")');
    await expect(page.locator('button:has-text("Ya tengo cuenta")')).toBeVisible();
    
    await page.click('button:has-text("Ya tengo cuenta")');
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect(page.locator('#auth-password')).toBeVisible();
  });

  test('debe mostrar botones OAuth', async ({ page }) => {
    await page.click('[data-view="auth"]');
    await expect(page.locator('button:has-text("Continuar con Google")')).toBeVisible();
    await expect(page.locator('button:has-text("Continuar con Apple")')).toBeVisible();
  });

  test('validación: debe requerir email en login (validación JS)', async ({ page }) => {
    await page.click('[data-view="auth"]');
    await page.fill('#auth-email', '');
    await page.fill('#auth-password', 'password123');
    await page.click('button:has-text("Entrar")');
    
    // La validación se hace en JS - verificar que muestra toast de error
    await expect(page.locator('#toast')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('#toast')).toContainText('Complete');
  });

  test('validación: debe requerir contraseña en login', async ({ page }) => {
    await page.click('[data-view="auth"]');
    await page.fill('#auth-email', 'test@test.com');
    await page.fill('#auth-password', '');
    await page.click('button:has-text("Entrar")');
    
    await expect(page.locator('#toast')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('#toast')).toContainText('Complete');
  });

  test('validación: debe requerir campos en registro', async ({ page }) => {
    await page.click('[data-view="auth"]');
    await page.click('button:has-text("Crear cuenta")');
    
    await page.fill('#reg-name', '');
    await page.fill('#reg-email', '');
    await page.fill('#reg-password', '');
    await page.fill('#reg-confirm', '');
    await page.click('button:has-text("Registrarse")');
    
    await expect(page.locator('#toast')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('#toast')).toContainText('Complete');
  });

  test('validación: contraseñas deben coincidir en registro', async ({ page }) => {
    await page.click('[data-view="auth"]');
    await page.click('button:has-text("Crear cuenta")');
    
    await page.fill('#reg-name', 'Test User');
    await page.fill('#reg-email', 'test@test.com');
    await page.fill('#reg-password', 'password123');
    await page.fill('#reg-confirm', 'different456');
    await page.click('button:has-text("Registrarse")');
    
    // La validación de coincidencia se hace en JS, no hay atributo HTML
    // Verificar que no navega (se queda en auth)
    await expect(page.locator('#view-auth')).toBeVisible();
  });
});

test.describe('Perfil (requiere login)', () => {
  test('debe mostrar botón de Perfil en nav solo si logueado', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.bottom-nav', { state: 'visible' });
    
    // Sin login, perfil no debería verse
    await expect(page.locator('#nav-profile')).toBeHidden();
    await expect(page.locator('#nav-auth')).toBeVisible();
  });
});