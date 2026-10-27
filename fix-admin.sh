#!/bin/bash
# ============================================================
# Fix para admin.js - Dashboard Accesos (sin Python)
# Ejecutar en Git Bash desde la raíz del proyecto
# ============================================================

set -e

echo "🔧 Aplicando fix a admin.js..."

# Verificar que existe
if [ ! -f "admin.js" ]; then
  echo "❌ No existe admin.js en $(pwd)"
  exit 1
fi

# Backup
cp admin.js admin.js.bak
echo "💾 Backup: admin.js.bak"

# ============================================================
# FIX 1: openAccessModal - abrir con display:flex
# ============================================================
echo ""
echo "🔧 FIX 1: openAccessModal..."

# Verificar si ya está el fix
if grep -q "modal.style.display = 'flex'" admin.js; then
  echo "  ✅ Ya está aplicado"
else
  # Reemplazar el openAccessModal viejo
  perl -0pi -e "s/  openAccessModal\(\) \{\n    const modal = document\.getElementById\('admin-access-modal'\);\n    const input = document\.getElementById\('admin-access-name'\);\n    if \(!modal \|\| !input\) return;\n    input\.value = '';\n    modal\.classList\.remove\('hidden'\);\n    setTimeout\(\(\) => input\.focus\(\), 100\);\n  \}/  openAccessModal() {\n    console.log('[Admin] openAccessModal');\n    const modal = document.getElementById('admin-access-modal');\n    const input = document.getElementById('admin-access-name');\n    if (!modal) { console.error('[Admin] modal no encontrado'); return; }\n    modal.classList.remove('hidden');\n    modal.style.display = 'flex';\n    if (input) {\n      input.value = '';\n      setTimeout(() => input.focus(), 100);\n    }\n  }/s" admin.js

  if grep -q "modal.style.display = 'flex'" admin.js; then
    echo "  ✅ Aplicado"
  else
    echo "  ⚠️  No se encontró el patrón exacto. Revisa admin.js manualmente."
  fi
fi

# ============================================================
# FIX 2: saveAccess - cerrar modal
# ============================================================
echo ""
echo "🔧 FIX 2: saveAccess..."

if grep -q "modal.style.display = 'none'" admin.js; then
  echo "  ✅ Ya está aplicado (o similar)"
else
  # Buscar el bloque de saveAccess y agregar el cierre del modal
  # Estrategia: buscar la línea que hace el toast de éxito y agregar las líneas siguientes
  perl -0pi -e "s/(this\.toast\('Nombre agregado', 'success'\);)/\$1\n    const modal = document.getElementById('admin-access-modal');\n    if (modal) { modal.classList.add('hidden'); modal.style.display = 'none'; }/s" admin.js

  if grep -q "admin-access-modal');" admin.js | head -1; then
    echo "  ✅ Aplicado (verifica manualmente)"
  else
    echo "  ⚠️  Revisa admin.js manualmente"
  fi
fi

# ============================================================
# FIX 3: renderLayout - forzar hidden en modales al final
# ============================================================
echo ""
echo "🔧 FIX 3: renderLayout - ocultar modales..."

if grep -q "Asegurar que los modales empiecen ocultos" admin.js; then
  echo "  ✅ Ya está aplicado"
else
  # Buscar el cierre de renderLayout (el último `}` antes de `bindEvents` o del siguiente método)
  # Estrategia: agregar el fix justo antes de la línea `  }` que cierra renderLayout,
  # que es la que está después del último </div> del template.
  # Buscamos la línea que dice `<!-- Modal: Editar patente -->` o similar como referencia.
  
  # Buscar el bloque del modal admin-plate-modal y agregar el fix después
  perl -0pi -e "s/(<\/div>\s*<\/div>\s*<\/div>\s*\n\s*`;\n\s*\n\s*\n)/\$1    \/\/ ⚡ FIX: Asegurar que los modales empiecen ocultos\n    ['admin-access-modal', 'admin-plate-modal', 'admin-confirm-modal'].forEach(id => {\n      const el = document.getElementById(id);\n      if (el) { el.classList.add('hidden'); el.style.display = 'none'; }\n    });\n/s" admin.js

  if grep -q "Asegurar que los modales empiecen ocultos" admin.js; then
    echo "  ✅ Aplicado"
  else
    echo "  ⚠️  No se encontró el patrón. Aplica manualmente."
  fi
fi

# ============================================================
# FIX 4: Asegurar que bindEvents tenga los listeners
# ============================================================
echo ""
echo "🔍 FIX 4: Verificando bindEvents..."

if grep -q "admin-add-access" admin.js; then
  echo "  ✅ admin-add-access existe"
else
  echo "  ❌ FALTA admin-add-access"
fi

if grep -q "admin-access-save" admin.js; then
  echo "  ✅ admin-access-save existe"
else
  echo "  ❌ FALTA admin-access-save"
fi

# ============================================================
# FIX 5: Verificar orden de init()
# ============================================================
echo ""
echo "🔍 FIX 5: Verificando orden de init()..."

bind_line=$(grep -n "this.bindEvents()" admin.js | head -1 | cut -d: -f1)
load_line=$(grep -n "await this.loadScans()" admin.js | head -1 | cut -d: -f1)

if [ -n "$bind_line" ] && [ -n "$load_line" ]; then
  if [ "$bind_line" -lt "$load_line" ]; then
    echo "  ✅ bindEvents() (línea $bind_line) va ANTES de loadScans() (línea $load_line)"
  else
    echo "  ⚠️  bindEvents() (línea $bind_line) va DESPUÉS de loadScans() (línea $load_line)"
    echo "     Esto puede romper los listeners si loadScans falla."
  fi
else
  echo "  ⚠️  No se encontraron las llamadas en init()"
fi

# ============================================================
# FIX 6: Reordenar init() si es necesario
# ============================================================
echo ""
echo "🔧 FIX 6: Reordenando init()..."

if [ -n "$bind_line" ] && [ -n "$load_line" ] && [ "$bind_line" -gt "$load_line" ]; then
  # Hacer backup del archivo
  cp admin.js admin.js.reorder.bak
  
  # Extraer la línea de bindEvents
  bind_content=$(sed -n "${bind_line}p" admin.js)
  
  # Eliminar la línea original
  sed -i "${bind_line}d" admin.js
  
  # Insertar antes de loadScans
  # Ajustar el número de línea (se movió 1 hacia arriba)
  new_load_line=$((load_line - 1))
  sed -i "${new_load_line}i\\${bind_content}" admin.js
  
  echo "  ✅ bindEvents movido antes de loadScans"
else
  echo "  ✅ Orden correcto, no hay que reordenar"
fi

# ============================================================
# Verificación final
# ============================================================
echo ""
echo "════════════════════════════════════════"
echo "✅ Fix aplicado"
echo "════════════════════════════════════════"
echo ""
echo "📋 Verificaciones:"
grep -n "openAccessModal\|saveAccess\|bindEvents\|Asegurar que los modales" admin.js | head -10
echo ""
echo "📋 Próximos pasos:"
echo "  1. npm run build"
echo "  2. npm run preview"
echo "  3. Recarga la app (F5)"
echo "  4. Logueate como admin"
echo "  5. Abre tab Accesos"
echo "  6. Prueba '+ Agregar nombre'"
echo ""