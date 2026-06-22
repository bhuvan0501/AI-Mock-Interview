import pdfplumber
from docx import Document
import os

def extract_text_from_pdf(path):
    text = ""
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
    return text

def extract_text_from_docx(path):
    doc = Document(path)
    text = ""
    for paragraph in doc.paragraphs:
        if paragraph.text:
            text += paragraph.text + "\n"
    return text

def extract_resume(path):
    """
    Checks the file extension and routes it to the correct parser.
    """
    _, extension = os.path.splitext(path.lower())
    
    if extension == '.pdf':
        return extract_text_from_pdf(path)
    elif extension == '.docx':
        return extract_text_from_docx(path)
    else:
        raise ValueError(f"Unsupported file format: {extension}")