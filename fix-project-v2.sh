#!/bin/bash
# ============================================================
# PlateDetect - Fix v2 (seguro, no rompe sintaxis)
# ============================================================

set -e

echo "🔧 Fix v2: reparando proyecto..."

# 0. Backup
BACKUP_DIR="../plate-detect-backup-v2-$(date +%s)"
mkdir -p "$BACKUP_DIR"
cp -r . "$BACKUP_DIR/" 2>/dev/null || true
echo "💾 Backup en: $BACKUP_DIR"

# ============================================================
# 1. Reparar app-supabase.js (quitar bloque roto del SW)
# ============================================================
echo ""
echo "🔧 Reparando app-supabase.js..."

if [ -f "app-supabase.js" ]; then
  # Eliminar la línea rota "/* eliminado ... */.catch(() => {});"
  sed -i.bak '/eliminado: vite-plugin-pwa registra el SW automáticamente \*\/\.catch/d' app-supabase.js
  rm -f app-supabase.js.bak

  # Verificar si quedó el bloque if huérfano y limpiarlo
  # Patrón: "if ('serviceWorker' in navigator) {" seguido de "}" sin cuerpo
  # Lo reemplazamos por un comentario seguro
  python3 - <<'PYEOF' 2>/dev/null || true
import re, pathlib
p = pathlib.Path("app-supabase.js")
if p.exists():
    src = p.read_text(encoding="utf-8")
    # Bloque vacío típico
    src = re.sub(
        r"if\s*\(\s*'serviceWorker'\s+in\s+navigator\s*\)\s*\{\s*\}",
        "// Service Worker: gestionado por vite-plugin-pwa (injectRegister: 'auto')",
        src
    )
    # Bloque con solo comentario
    src = re.sub(
        r"if\s*\(\s*'serviceWorker'\s+in\s+navigator\s*\)\s*\{\s*//[^\n]*\s*\}",
        "// Service Worker: gestionado por vite-plugin-pwa (injectRegister: 'auto')",
        src
    )
    p.write_text(src, encoding="utf-8")
PYEOF

  echo "  → app-supabase.js reparado"
fi

# ============================================================
# 2. Reparar main.js (por si el sed anterior rompió algo)
# ============================================================
echo ""
echo "🔧 Verificando main.js..."

if [ -f "main.js" ]; then
  # Buscar cualquier resto raro
  if grep -q "eliminado: vite-plugin-pwa" main.js 2>/dev/null; then
    sed -i.bak '/eliminado: vite-plugin-pwa/d' main.js
    rm -f main.js.bak
    echo "  → main.js limpiado"
  else
    echo "  → main.js OK"
  fi
fi

# ============================================================
# 3. Verificar estructura final
# ============================================================
echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ Verificación"
echo "════════════════════════════════════════════════════════"
echo ""
echo "📋 Archivos JS en raíz:"
ls -la *.js 2>/dev/null || echo "  (ninguno)"
echo ""
echo "📋 public/models/:"
ls -la public/models/ 2>/dev/null || echo "  (no existe)"
echo ""
echo "📋 ¿Quedan archivos duplicados?"
for f in app.js sw.js manifest.json en_dict.txt; do
  if [ -f "$f" ]; then
    echo "  ⚠️  $f todavía existe en la raíz (debería estar eliminado)"
  fi
done
echo ""
echo "════════════════════════════════════════════════════════"
echo "Siguiente paso:"
echo "════════════════════════════════════════════════════════"
echo "  npm run build"
echo ""