"""Google Cloud Storage service for video clip storage.

Clips are stored in a public-read bucket. URLs are permanent public GCS URLs
(no signed URL expiry). The bucket uses uniform access control with allUsers
granted the Storage Object Viewer role, making all objects publicly readable
by URL but not listable/browsable.

Path structure: projects/{project_id}/clips/{clip_id}_{filename}
"""

import datetime
import os
from pathlib import Path
from typing import Optional

from google.cloud import storage

from app.config import settings


_client: Optional[storage.Client] = None


def _get_client() -> storage.Client:
    """Get a GCS client, resolving credentials path."""
    creds_path = settings.google_application_credentials
    if creds_path and not os.path.isabs(creds_path):
        resolved = str(Path(__file__).parent.parent.parent / creds_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved

    return storage.Client(project=settings.google_cloud_project)


def get_client() -> storage.Client:
    """Get or create the GCS client singleton."""
    global _client
    if _client is None:
        _client = _get_client()
    return _client


def get_bucket() -> storage.Bucket:
    """Get the configured GCS bucket."""
    client = get_client()
    return client.bucket(settings.gcs_bucket_name)


def _build_blob_path(project_id: str, filename: str) -> str:
    """Build the GCS object path for a clip."""
    return f"projects/{project_id}/clips/{filename}"


def _public_url(blob_path: str) -> str:
    """Build the permanent public URL for a GCS object."""
    return f"https://storage.googleapis.com/{settings.gcs_bucket_name}/{blob_path}"


def upload_to_gcs(
    file_content: bytes,
    project_id: str,
    filename: str,
    content_type: str = "video/mp4",
) -> str:
    """Upload a clip to GCS and return the public URL.

    Args:
        file_content: Raw bytes of the video file.
        project_id: Project identifier (used in path).
        filename: Storage filename (typically {clip_id}_{original_name}).
        content_type: MIME type of the file.

    Returns:
        Public URL for the uploaded file.
    """
    bucket = get_bucket()
    blob_path = _build_blob_path(project_id, filename)
    blob = bucket.blob(blob_path)

    blob.upload_from_string(file_content, content_type=content_type)

    return _public_url(blob_path)


def get_clip_url(project_id: str, filename: str) -> str:
    """Get the public playback URL for an existing clip.

    Args:
        project_id: Project identifier.
        filename: The stored filename.

    Returns:
        Public URL for the clip.
    """
    blob_path = _build_blob_path(project_id, filename)
    return _public_url(blob_path)


def delete_clip(project_id: str, filename: str) -> bool:
    """Delete a clip from GCS.

    Args:
        project_id: Project identifier.
        filename: The stored filename.

    Returns:
        True if deleted, False if the blob didn't exist.
    """
    bucket = get_bucket()
    blob_path = _build_blob_path(project_id, filename)
    blob = bucket.blob(blob_path)

    if blob.exists():
        blob.delete()
        return True
    return False


def generate_upload_signed_url(
    project_id: str,
    filename: str,
    content_type: str = "video/mp4",
    expiration_minutes: int = 15,
) -> dict:
    """Generate a signed URL that lets the client upload a file directly to GCS.

    This bypasses the Cloud Run 32MB request limit -- the browser PUTs the file
    straight to GCS, never through the backend. After upload, the file lands at
    the same path a backend upload would have used, so the pipeline is unaffected.

    On Cloud Run (no local key file), signing uses the attached service account
    via the IAM signBlob API. Locally, it uses the service account key file.

    Args:
        project_id: Project identifier (used in the GCS path).
        filename: Storage filename (typically {clip_id}_{original_name}).
        content_type: MIME type the client must send with the PUT.
        expiration_minutes: How long the signed URL stays valid.

    Returns:
        dict with signed_url (for the PUT), gcs_url (permanent public URL),
        blob_path, and content_type.
    """
    bucket = get_bucket()
    blob_path = _build_blob_path(project_id, filename)
    blob = bucket.blob(blob_path)

    expiration = datetime.timedelta(minutes=expiration_minutes)

    # Determine signing method: local key file vs Cloud Run IAM signing
    creds_path = settings.google_application_credentials
    resolved_path = creds_path
    if creds_path and not os.path.isabs(creds_path):
        resolved_path = str(Path(__file__).parent.parent.parent / creds_path)

    if resolved_path and os.path.exists(resolved_path):
        # Local: sign with the service account key file directly
        signed_url = blob.generate_signed_url(
            version="v4",
            expiration=expiration,
            method="PUT",
            content_type=content_type,
        )
    else:
        # Cloud Run: no key file. Sign via IAM using the attached service account.
        import google.auth
        from google.auth.transport.requests import Request as GoogleAuthRequest

        credentials, _ = google.auth.default()
        credentials.refresh(GoogleAuthRequest())

        service_account_email = getattr(credentials, "service_account_email", None)
        if not service_account_email:
            service_account_email = (
                f"all-things-agent-hackathon@{settings.google_cloud_project}.iam.gserviceaccount.com"
            )

        signed_url = blob.generate_signed_url(
            version="v4",
            expiration=expiration,
            method="PUT",
            content_type=content_type,
            service_account_email=service_account_email,
            access_token=credentials.token,
        )

    return {
        "signed_url": signed_url,
        "gcs_url": _public_url(blob_path),
        "blob_path": blob_path,
        "content_type": content_type,
    }


def download_clip(project_id: str, filename: str) -> bytes:
    """Download a clip's content from GCS.

    Args:
        project_id: Project identifier.
        filename: The stored filename.

    Returns:
        Raw bytes of the file.

    Raises:
        ValueError: If the blob doesn't exist.
    """
    bucket = get_bucket()
    blob_path = _build_blob_path(project_id, filename)
    blob = bucket.blob(blob_path)

    if not blob.exists():
        raise ValueError(f"Clip not found in GCS: {blob_path}")

    return blob.download_as_bytes()
