# Generated migration for adding approximate location fields to DroneProject.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("processing", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="droneproject",
            name="approx_latitude",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="droneproject",
            name="approx_longitude",
            field=models.FloatField(blank=True, null=True),
        ),
    ]
