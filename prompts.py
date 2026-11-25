"""Esquemas JSON para el análisis de las dos bibliotecas."""

from pydantic import BaseModel, Field


class Suggestion(BaseModel):
    target_owner: str
    recommended_book_id: int
    related_book_ids: list[int]
    reason: str = Field(
        description=(
            "Explicación en español de 200 a 300 palabras. Debe explicar con "
            "ideas concretas la conexión entre el libro recomendado y el libro "
            "seleccionado, sin relleno ni detalles inventados."
        )
    )


class BookLink(BaseModel):
    source_book_id: int
    target_book_id: int
    reason: str = Field(
        description=(
            "Explicación breve en español, de menos de 100 palabras, sobre la "
            "conexión directa entre las dos obras."
        )
    )


class Analysis(BaseModel):
    recommendations: list[Suggestion] = Field(max_length=4)
    relationships: list[BookLink]
