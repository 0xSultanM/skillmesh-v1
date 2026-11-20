from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie


@ensure_csrf_cookie
def index(request):
    return render(request, "web/index.html")


@ensure_csrf_cookie
def tutmesh(request):
    """Browser-only roadmap tracker. Roadmaps and progress live in localStorage."""
    return render(request, "web/tutmesh.html")


def privacy(request):
    return render(request, "web/privacy.html")
