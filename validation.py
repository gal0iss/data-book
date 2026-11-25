"""Carga el catálogo y valida las respuestas de Gemini."""

import json
from pathlib import Path
from typing import Any
from pydantic import ValidationError
from prompts import Analysis, BookLink, Suggestion


MAX_RELATIONSHIP_WORDS = 99


class AppError(Exception):
    """Error que se puede mostrar directamente al usuario."""


def load_books(path: str | Path) -> list[dict[str, Any]]:
    """Lee el catálogo y comprueba sus campos y valores permitidos."""
    try:
        with Path(path).open(encoding="utf-8") as file:
            books = json.load(file)
    except (OSError, json.JSONDecodeError) as exc:
        raise AppError(f"No se pudo leer el catálogo {path}: {exc}") from exc

    if not isinstance(books, list):
        raise AppError("El catálogo debe ser una lista JSON.")

    book_ids: set[int] = set()
    required_fields = {"id", "title", "author", "owner"}
    for index, book in enumerate(books, start=1):
        if not isinstance(book, dict) or set(book) != required_fields:
            raise AppError(
                f"El registro {index} debe contener solo id, title, author y owner."
            )

        book_id = book["id"]
        if isinstance(book_id, bool) or not isinstance(book_id, int) or book_id <= 0:
            raise AppError(f"El ID del registro {index} debe ser un entero positivo.")
        if book_id in book_ids:
            raise AppError(f"ID duplicado en el catálogo: {book_id}.")
        book_ids.add(book_id)

        for field in ("title", "author"):
            value = book[field]
            if not isinstance(value, str) or not value.strip():
                raise AppError(f"{field} no puede estar vacío (registro {index}).")
        if book["owner"] not in ("A", "B"):
            raise AppError(f"Propietario inválido en el registro {index}: use A o B.")

    return books


def get_book(books: list[dict[str, Any]], book_id: int) -> dict[str, Any]:
    """Busca un libro por ID y reporta si no existe o está duplicado."""
    matches = [book for book in books if book["id"] == book_id]
    if not matches:
        raise AppError(f"No existe un libro con ID {book_id}.")
    if len(matches) > 1:
        raise AppError(f"El catálogo repite el ID {book_id}.")
    return matches[0]


def _check_response_shape(data: dict[str, Any]) -> None:
    """Comprueba que la respuesta tenga los campos JSON esperados."""
    if set(data) != {"recommendations", "relationships"}:
        raise AppError(
            "La respuesta debe contener solo recommendations y relationships."
        )
    if not isinstance(data["recommendations"], list):
        raise AppError("recommendations debe ser una lista.")
    if not isinstance(data["relationships"], list):
        raise AppError("relationships debe ser una lista.")

    required_fields = {
        "target_owner", "recommended_book_id", "related_book_ids", "reason"
    }
    for index, item in enumerate(data["recommendations"], start=1):
        if not isinstance(item, dict) or set(item) != required_fields:
            raise AppError(
                f"Elemento {index} de recommendations: campos incorrectos."
            )


def _validate_recommendations(
    recommendations: list[Suggestion],
    books_by_id: dict[int, dict[str, Any]],
    selected_book_id: int,
) -> None:
    """Comprueba que cada sugerencia se base en el libro seleccionado."""
    if len(recommendations) > 4:
        raise AppError("La respuesta no puede tener más de cuatro recomendaciones.")

    selected_book = books_by_id[selected_book_id]
    expected_owner = selected_book["owner"]

    seen_suggestions: set[tuple[str, int]] = set()
    for suggestion in recommendations:
        owner = suggestion.target_owner
        if owner != expected_owner:
            raise AppError(
                "target_owner debe coincidir con el propietario del libro seleccionado."
            )

        book_id = suggestion.recommended_book_id
        if book_id not in books_by_id:
            raise AppError(f"ID recomendado inexistente: {book_id}.")
        if books_by_id[book_id]["owner"] == owner:
            raise AppError(
                f"El libro {book_id} no pertenece a la biblioteca contraria."
            )
        word_count = len(suggestion.reason.split())
        if not 200 <= word_count <= 300:
            raise AppError(
                "Cada recomendación debe tener entre 200 y 300 palabras; "
                f"recibidas: {word_count}."
            )

        key = (owner, book_id)
        if key in seen_suggestions:
            raise AppError(
                f"Recomendación duplicada para el libro {book_id} y {owner}."
            )
        seen_suggestions.add(key)


def _normalize_recommendation_context(
    recommendations: list[Suggestion], selected_book_id: int
) -> None:
    """Fija el contexto de cada recomendación al libro que eligió el usuario."""
    for suggestion in recommendations:
        suggestion.related_book_ids = [selected_book_id]


def _build_direct_relationships(
    recommendations: list[Suggestion],
    selected_book_id: int,
    raw_relationships: list[Any],
) -> list[BookLink]:
    """Crea relaciones directas con explicaciones breves."""
    relationships: list[BookLink] = []
    for suggestion in recommendations:
        reason = _find_relationship_reason(
            raw_relationships,
            selected_book_id,
            suggestion.recommended_book_id,
        )
        relationships.append(
            BookLink(
                source_book_id=selected_book_id,
                target_book_id=suggestion.recommended_book_id,
                reason=_limit_words(reason or suggestion.reason),
            )
        )
    return relationships


def _find_relationship_reason(
    relationships: list[Any],
    selected_book_id: int,
    recommended_book_id: int,
) -> str | None:
    """Busca la explicación directa entregada por Gemini, si es válida."""
    expected_ids = {selected_book_id, recommended_book_id}
    for relationship in relationships:
        if not isinstance(relationship, dict):
            continue

        source_id = relationship.get("source_book_id")
        target_id = relationship.get("target_book_id")
        reason = relationship.get("reason")
        ids_are_integers = all(
            isinstance(book_id, int) and not isinstance(book_id, bool)
            for book_id in (source_id, target_id)
        )
        if (
            ids_are_integers
            and {source_id, target_id} == expected_ids
            and isinstance(reason, str)
            and reason.strip()
        ):
            return reason.strip()
    return None


def _limit_words(text: str) -> str:
    """Limita un texto a menos de cien palabras sin alterar el original largo."""
    words = text.split()
    if len(words) <= MAX_RELATIONSHIP_WORDS:
        return " ".join(words)
    return f"{' '.join(words[:MAX_RELATIONSHIP_WORDS]).rstrip('.,;:')}…"


def validate_response(
    data: dict[str, Any],
    books: list[dict[str, Any]],
    selected_book_id: int,
) -> dict[str, Any]:
    """Valida el esquema y las referencias de la respuesta."""
    _check_response_shape(data)
    try:
        normalized_data = {**data, "relationships": []}
        result = Analysis.model_validate(normalized_data)
    except ValidationError as exc:
        raise AppError(f"La respuesta no cumple el esquema requerido: {exc}") from exc

    _normalize_recommendation_context(result.recommendations, selected_book_id)

    books_by_id = {book["id"]: book for book in books}
    if len(books_by_id) != len(books):
        raise AppError("El catálogo contiene IDs duplicados.")
    if selected_book_id not in books_by_id:
        raise AppError(f"El libro seleccionado no existe: {selected_book_id}.")

    _validate_recommendations(
        result.recommendations,
        books_by_id,
        selected_book_id,
    )
    result.relationships = _build_direct_relationships(
        result.recommendations,
        selected_book_id,
        data["relationships"],
    )
    return result.model_dump()
