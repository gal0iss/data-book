"""Coordina la solicitud a Gemini y devuelve recomendaciones validadas."""

import json
import os
from typing import Any

from dotenv import load_dotenv
from google import genai
from google.genai import types

from prompt_builder import build_prompt
from prompts import Analysis
from validation import AppError, get_book, validate_response


DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite"


def _is_high_demand_error(error: Exception) -> bool:
    """Detecta solo el 503 por alta demanda, sin confundirlo con cuota."""
    if getattr(error, "status_code", None) != 503:
        return False

    response_json = getattr(error, "response_json", {})
    details = f"{response_json} {error}".lower()
    return "high demand" in details and "quota" not in details


def _generate(client: Any, model: str, prompt: str) -> Any:
    return client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=Analysis,
        ),
    )


def recommend(
    books: list[dict[str, Any]],
    selected_book_id: int,
    *,
    client: Any | None = None,
    model: str | None = None,
    api_key: str | None = None,
    fallback_model: str | None = None,
) -> dict[str, Any]:
    """Recomienda libros de la otra biblioteca relacionados con el seleccionado."""
    get_book(books, selected_book_id)
    load_dotenv()
    api_key = api_key or os.getenv("GEMINI_API_KEY")
    model = model or os.getenv("GEMINI_MODEL")
    fallback_model = (
        fallback_model
        or os.getenv("GEMINI_FALLBACK_MODEL")
        or DEFAULT_FALLBACK_MODEL
    )
    if not api_key:
        raise AppError("Falta GEMINI_API_KEY. Configúrala en el archivo .env.")
    if not model:
        raise AppError("Falta GEMINI_MODEL. Configura un modelo Flash en .env.")
    try:
        client = client or genai.Client(api_key=api_key)
    except Exception as exc:
        raise AppError(f"No se pudo inicializar el cliente de Gemini: {exc}") from exc

    prompt = build_prompt(books, selected_book_id)
    try:
        response = _generate(client, model, prompt)
    except Exception as primary_error:
        if not _is_high_demand_error(primary_error) or fallback_model == model:
            raise AppError(
                f"Error al consultar Gemini: {primary_error}"
            ) from primary_error
        try:
            response = _generate(client, fallback_model, prompt)
        except Exception as fallback_error:
            raise AppError(
                f"El modelo principal {model} está con alta demanda y el modelo "
                f"alternativo {fallback_model} también falló: {fallback_error}"
            ) from fallback_error

    if not response.text:
        raise AppError("Gemini devolvió una respuesta vacía o sin contenido JSON.")
    try:
        data = json.loads(response.text)
    except json.JSONDecodeError as exc:
        raise AppError(f"Gemini devolvió JSON inválido: {exc}") from exc
    if not isinstance(data, dict):
        raise AppError("La respuesta JSON de Gemini debe ser un objeto.")

    return validate_response(data, books, selected_book_id)
