# Autonomous-driving localization and mapping preset

Use this preset to ask better questions and choose realistic practice. It is not a fixed syllabus.

## Diagnostic dimensions

In addition to the shared six fields, clarify only dimensions that affect the route:

- mathematics: linear algebra, probability, calculus, optimization;
- programming: Python/C++, Linux, Git, build systems;
- robotics foundations: coordinate frames, rigid transforms, rotations, timing;
- sensors available or of interest: GNSS/RTK, IMU, wheel odometry, camera, LiDAR, radar;
- software/data: ROS/ROS 2, simulator, public dataset, own hardware, GPU;
- intended emphasis: state estimation, visual SLAM, LiDAR SLAM, multisensor fusion, HD maps, or system engineering.

Do not require all of these before starting. Missing mathematics or hardware changes the route; it does not disqualify the learner.

## Concept map

Choose the subset needed for the goal:

1. frames, homogeneous transforms, SO(3)/SE(3), and uncertainty;
2. sensor models, calibration, synchronization, and observability;
3. Bayesian estimation, least squares, Kalman-family filters, particle filters;
4. front-end association: features, scan matching, odometry;
5. back-end estimation: factor graphs, nonlinear optimization, marginalization;
6. loop closure, relocalization, map representations, and evaluation;
7. engineering: datasets, coordinate conventions, logs, visualization, reproducibility.

Explain that localization and mapping are coupled estimation problems. Avoid equating SLAM with only cameras or only GPS-denied operation.

## Practice ladder examples

Select projects compatible with the learner's tools:

- transform and visualize poses across coordinate frames;
- implement and evaluate a 1D/2D Kalman filter on synthetic noisy motion;
- fuse IMU with GNSS or wheel odometry on a public dataset;
- run a maintained visual or LiDAR odometry pipeline and interpret trajectories;
- build a small pose graph, add a loop closure, and observe global correction;
- compare estimates using trajectory error and write a reproducible experiment report.

Running a large SLAM repository is not evidence of understanding by itself. Require an explanation of assumptions, coordinate frames, error sources, and evaluation results.

## Resource selection

Search official university course pages, canonical textbooks, primary papers, and maintained project documentation. Verify software compatibility and dataset links at use time. Distinguish conceptual resources from implementation references and warn when a resource assumes advanced probability, optimization, or C++.
