"""
Wipe all test data: Firestore collections (projects, jobs) and GCS bucket contents.
Run from project root: ./venv/bin/python scripts/wipe_all_data.py
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Load environment
load_dotenv(Path(__file__).parent.parent / ".env")

creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
if creds_path and not os.path.isabs(creds_path):
    creds_path = str(Path(__file__).parent.parent / creds_path)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_path

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "molten-seat-505917-u0")
BUCKET_NAME = "all-things-agentic-hackathon-projects"
FIRESTORE_DB = "all-things-agent-hackathon"


def wipe_firestore():
    """Delete all documents in projects and jobs collections."""
    from google.cloud import firestore

    db = firestore.Client(project=PROJECT, database=FIRESTORE_DB)

    collections_to_wipe = ["projects", "jobs"]

    for collection_name in collections_to_wipe:
        print(f"\n  Wiping Firestore collection: {collection_name}")
        docs = db.collection(collection_name).stream()
        count = 0
        for doc in docs:
            doc.reference.delete()
            count += 1
        print(f"    Deleted {count} documents")


def wipe_gcs():
    """Delete all objects in the GCS bucket."""
    from google.cloud import storage

    client = storage.Client(project=PROJECT)

    try:
        bucket = client.get_bucket(BUCKET_NAME)
    except Exception as e:
        print(f"  Could not access bucket '{BUCKET_NAME}': {e}")
        return

    blobs = list(bucket.list_blobs())
    print(f"\n  Wiping GCS bucket: {BUCKET_NAME}")
    print(f"    Found {len(blobs)} objects")

    if blobs:
        bucket.delete_blobs(blobs)
        print(f"    Deleted {len(blobs)} objects")
    else:
        print("    Bucket already empty")


def wipe_local_uploads():
    """Delete all files in backend/uploads/."""
    import shutil

    uploads_dir = Path(__file__).parent.parent / "backend" / "uploads"
    if not uploads_dir.exists():
        print("\n  No local uploads/ directory found")
        return

    # Count files
    files = list(uploads_dir.rglob("*"))
    file_count = sum(1 for f in files if f.is_file())
    dir_count = sum(1 for f in files if f.is_dir())

    print(f"\n  Wiping local uploads: {uploads_dir}")
    print(f"    Found {file_count} files in {dir_count} directories")

    # Remove all subdirectories (each is a project folder)
    for item in uploads_dir.iterdir():
        if item.is_dir():
            shutil.rmtree(item)

    print(f"    Done -- uploads/ directory is now empty")


def main():
    print("=" * 50)
    print("  WIPING ALL TEST DATA")
    print("=" * 50)
    print(f"\n  Project: {PROJECT}")
    print(f"  Firestore DB: {FIRESTORE_DB}")
    print(f"  GCS Bucket: {BUCKET_NAME}")

    print("\n--- Firestore ---")
    wipe_firestore()

    print("\n--- GCS ---")
    wipe_gcs()

    print("\n--- Local uploads ---")
    wipe_local_uploads()

    print("\n" + "=" * 50)
    print("  ALL DATA WIPED SUCCESSFULLY")
    print("=" * 50)


if __name__ == "__main__":
    main()
