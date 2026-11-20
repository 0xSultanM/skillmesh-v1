"""
WSGI config for SkillMesh AI project.
Uses WhiteNoise for static files and auto-migration + seeding on startup.
"""
import os
from django.core.wsgi import get_wsgi_application
from whitenoise import WhiteNoise

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'skillmesh.settings')

# Initialize Django first
application = get_wsgi_application()
application = WhiteNoise(application, root=os.path.join(os.path.dirname(os.path.dirname(__file__)), 'staticfiles'))
application.add_files(os.path.join(os.path.dirname(os.path.dirname(__file__)), 'staticfiles'), prefix='static/')

# Auto-run migrations and seed data on first startup
try:
    from django.core.management import call_command
    from django.db import connection
    
    print("Running database migrations...")
    call_command('migrate', '--run-syncdb', verbosity=0)
    print("✓ Migrations completed successfully.")
    
    # Check if database is empty (first deployment)
    with connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) FROM taxonomy_skill")
        skill_count = cursor.fetchone()[0]
    
    if skill_count == 0:
        print("Database is empty. Seeding initial data...")
        call_command('seed_taxonomy', verbosity=0)
        print("✓ Seeded taxonomy (83 skills)")
        call_command('seed_resources', verbosity=0)
        print("✓ Seeded resources")
        call_command('seed_videos', verbosity=0)
        print("✓ Seeded videos")
        
        # Create superuser if credentials provided in environment variables
        admin_user = os.getenv('DJANGO_ADMIN_USERNAME')
        admin_email = os.getenv('DJANGO_ADMIN_EMAIL')
        admin_pass = os.getenv('DJANGO_ADMIN_PASSWORD')
        if admin_user and admin_email and admin_pass:
            from django.contrib.auth.models import User
            if not User.objects.filter(username=admin_user).exists():
                User.objects.create_superuser(admin_user, admin_email, admin_pass)
                print(f"✓ Created superuser: {admin_user}")
    else:
        print(f"Database already has {skill_count} skills. Skipping seed.")
    
    print("✓ Database setup complete.")
    
except Exception as e:
    print(f"Setup warning: {e}")
    # Don't fail startup if setup fails
