"""Punto de entrada para ejecutar el recomendador en terminal."""

import json
from pathlib import Path

from recommender import recommend
from validation import AppError, load_books


def main() -> int:
    catalog_path = Path(__file__).parent / "data" / "books.json"
    try:
        books = load_books(catalog_path)
        for book in books:
            print(f"{book['id']}: {book['title']} — {book['author']} ({book['owner']})")
        selected_book_id = int(
            input("ID del libro para el que quieres recomendaciones: ")
        )
        result = recommend(books, selected_book_id)
    except ValueError:
        print("Error: ingresa un ID numérico.")
        return 1
    except AppError as exc:
        print(f"Error: {exc}")
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
