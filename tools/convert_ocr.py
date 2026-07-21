"""
Convierte PP-OCRv3 Mobile Slim Recognition a TFLite para usar con LiteRT.js

Requisitos:
    pip install paddlepaddle paddle2onnx onnx tf-nightly onnx-tf

Uso:
    python convert_ocr.py

El script:
1. Descarga PP-OCRv3 Mobile Slim Recognition desde el CDN oficial de PaddleOCR
2. Convierte el modelo PaddlePaddle → ONNX
3. Convierte ONNX → TensorFlow SavedModel
4. Convierte TensorFlow → TFLite (float32)
5. Guarda plate_ocr.tflite en la carpeta models/

Después, copia plate_ocr.tflite a la carpeta del proyecto parking-liteRT
y subre el archivo a GitHub Pages.
"""

import os
import subprocess
import urllib.request
import tarfile

# Configuración
MODEL_URL = "https://paddleocr.bj.bcebos.com/PP-OCRv3/english/ch_PP-OCRv3_rec_slim_infer.tar"
WORK_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(WORK_DIR, "models")
TMP_DIR = os.path.join(WORK_DIR, "tmp_ocr")

def step(msg):
    print(f"\n{'='*60}\n  {msg}\n{'='*60}")

def run(cmd):
    print(f"$ {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR:\n{result.stderr}")
        raise RuntimeError(f"Comando fallo: {cmd}")
    return result.stdout

def download_and_extract():
    step("1. Descargando PP-OCRv3 Mobile Slim Recognition")
    os.makedirs(TMP_DIR, exist_ok=True)
    tar_path = os.path.join(TMP_DIR, "model.tar")

    if not os.path.exists(tar_path):
        print(f"Descargando desde {MODEL_URL}...")
        urllib.request.urlretrieve(MODEL_URL, tar_path)
        print("Descarga completa.")

    print("Extrayendo...")
    with tarfile.open(tar_path, "r:*") as tar:
        tar.extractall(TMP_DIR)

    # Encontrar los archivos del modelo
    model_dir = os.path.join(TMP_DIR, "ch_PP-OCRv3_rec_slim_infer")
    if not os.path.exists(model_dir):
        # Buscar el directorio
        for d in os.listdir(TMP_DIR):
            full = os.path.join(TMP_DIR, d)
            if os.path.isdir(full) and "OCRv3" in d:
                model_dir = full
                break

    pdmodel = None
    pdparams = None
    for f in os.listdir(model_dir):
        if f.endswith(".pdmodel"):
            pdmodel = os.path.join(model_dir, f)
        elif f.endswith(".pdiparams"):
            pdparams = os.path.join(model_dir, f)

    if not pdmodel or not pdparams:
        raise FileNotFoundError(f"No se encontraron .pdmodel/.pdiparams en {model_dir}")

    print(f"Modelo: {pdmodel}")
    print(f"Params: {pdparams}")
    return pdmodel, pdparams

def paddle_to_onnx(pdmodel, pdparams):
    step("2. Convirtiendo PaddlePaddle a ONNX")
    onnx_path = os.path.join(TMP_DIR, "plate_ocr.onnx")

    # Usar paddle2onnx directamente
    import paddle2onnx
    paddle2onnx.export(
        model_file=pdmodel,
        params_file=pdparams,
        save_file=onnx_path,
        input_shape_dict={"x": [-1, 3, 48, -1]},  # [batch, channels, height, width]
        opset_version=14,
        enable_onnx_checker=True,
    )

    # Copiar archivo de diccionario (caracteres alfanumericos)
    dict_url = "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/en_dict.txt"
    dict_path = os.path.join(TMP_DIR, "en_dict.txt")
    if not os.path.exists(dict_path):
        urllib.request.urlretrieve(dict_url, dict_path)

    print(f"ONNX guardado: {onnx_path}")
    print(f"Diccionario: {dict_path}")
    return onnx_path, dict_path

def onnx_to_tflite(onnx_path):
    step("3. Convirtiendo ONNX a TensorFlow")
    saved_model_dir = os.path.join(TMP_DIR, "saved_model")

    # onnx -> tf saved model
    import onnx
    from onnx_tf.backend import prepare
    onnx_model = onnx.load(onnx_path)
    tf_rep = prepare(onnx_model, device="CPU")
    tf_rep.export_graph(saved_model_dir)

    step("4. Convirtiendo TensorFlow a TFLite")
    import tensorflow as tf

    # Crear directorio models
    os.makedirs(MODELS_DIR, exist_ok=True)

    converter = tf.lite.TFLiteConverter.from_saved_model(saved_model_dir)
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS]
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.allow_custom_ops = True

    tflite_model = converter.convert()
    tflite_path = os.path.join(MODELS_DIR, "plate_ocr.tflite")

    with open(tflite_path, "wb") as f:
        f.write(tflite_model)

    size_mb = os.path.getsize(tflite_path) / (1024 * 1024)
    print(f"TFLite guardado: {tflite_path} ({size_mb:.1f} MB)")
    return tflite_path

def copy_dict_to_models(dict_path):
    """Copia el diccionario de caracteres al directorio models"""
    import shutil
    dest = os.path.join(MODELS_DIR, "en_dict.txt")
    shutil.copy2(dict_path, dest)
    print(f"Diccionario copiado: {dest}")

def main():
    print("""
╔══════════════════════════════════════════════════════════╗
║  Conversor PP-OCRv3 Mobile Slim -> TFLite               ║
║  Para parking-liteRT (LiteRT.js)                        ║
╚══════════════════════════════════════════════════════════╝
    """)

    try:
        pdmodel, pdparams = download_and_extract()
        onnx_path, dict_path = paddle_to_onnx(pdmodel, pdparams)
        tflite_path = onnx_to_tflite(onnx_path)
        copy_dict_to_models(dict_path)

        step("CONVERSION COMPLETADA")
        print(f"""
Archivos generados en {MODELS_DIR}/:
  - plate_ocr.tflite   (modelo OCR para LiteRT.js)
  - en_dict.txt        (diccionario de caracteres)

PROXIMO PASO:
  Copia plate_ocr.tflite y en_dict.txt a la carpeta del proyecto
  parking-liteRT y subre los archivos a GitHub.

  El modelo se carga automaticamente en app.js cuando detecta
  el archivo plate_ocr.tflite en el servidor.
        """)

    except Exception as e:
        print(f"\nERROR: {e}")
        print("\nSolucion de problemas:")
        print("  1. Instala dependencias: pip install paddlepaddle paddle2onnx onnx tf-nightly onnx-tf")
        print("  2. En Windows puede requerir Visual C++ Redistributable")
        print("  3. Si paddle2onnx falla, prueba: pip install paddle2onnx==1.0.5")
        return 1

    return 0

if __name__ == "__main__":
    exit(main())