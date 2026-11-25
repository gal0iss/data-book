"""Servidor local para la interfaz web y las recomendaciones."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from recommender import recommend
from validation import AppError, get_book, load_books


ROOT = Path(__file__).parent
BOOKS_PATH = ROOT / "data" / "books.json"
UI_PATH = ROOT / "biblioteca-ui"
INDEX_PATH = UI_PATH / "index.html"
MAX_BODY_SIZE = 4096


class LibraryHandler(BaseHTTPRequestHandler):
    """Sirve el catálogo y procesa peticiones para una obra seleccionada."""

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            self._send_file(INDEX_PATH, "text/html; charset=utf-8")
        elif path == "/styles.css":
            self._send_file(UI_PATH / "styles.css", "text/css; charset=utf-8")
        elif path == "/app.js":
            self._send_file(UI_PATH / "app.js", "text/javascript; charset=utf-8")
        elif path == "/api/books":
            try:
                self._send_json(200, load_books(BOOKS_PATH))
            except AppError as exc:
                self._send_json(500, {"error": str(exc)})
        else:
            self._send_json(404, {"error": "Ruta no encontrada."})

    def do_POST(self) -> None:
        if urlsplit(self.path).path != "/api/recommendations":
            self._send_json(404, {"error": "Ruta no encontrada."})
            return

        try:
            body_size = int(self.headers.get("Content-Length", "0"))
            if body_size <= 0 or body_size > MAX_BODY_SIZE:
                raise ValueError("Tamaño de solicitud inválido.")

            payload = json.loads(self.rfile.read(body_size))
            book_id = payload.get("book_id") if isinstance(payload, dict) else None

            if isinstance(book_id, bool) or not isinstance(book_id, int):
                raise ValueError("Envía un book_id entero.")

            books = load_books(BOOKS_PATH)
            get_book(books, book_id)

        except (ValueError, json.JSONDecodeError, AppError) as exc:
            self._send_json(400, {"error": str(exc)})
            return

        try:
            result = recommend(books, book_id)
        except AppError as exc:
            self._send_json(502, {"error": str(exc)})
            return

        self._send_json(200, result)

    def _send_file(self, path: Path, content_type: str) -> None:
        try:
            content = path.read_bytes()
        except OSError:
            self._send_json(
                404, {"error": "No se pudo encontrar el archivo solicitado."}
            )
            return
        self._send_bytes(content, content_type)

    def _send_bytes(self, encoded: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _send_json(self, status: int, payload: object) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    address = ("127.0.0.1", 8000)
    server = ThreadingHTTPServer(address, LibraryHandler)
    print(f"Abre http://{address[0]}:{address[1]} en tu navegador. Ctrl+C para salir.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
