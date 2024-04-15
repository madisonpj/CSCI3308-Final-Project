//  Import dependencies
const express = require("express");
const app = express(); // Create Express app
const bodyParser = require('body-parser');
const session = require('express-session');

const handlebars = require("express-handlebars");


const path = require("path");

const bcrypt = require('bcrypt'); 
const pgp = require('pg-promise')();

const statusCodes = require('./statusCodes.js');
const authentication = require('./authentication.js');
const { search, getCourseInfo } = require("./cu-api.js");
const { vote, deleteVote, getVote } = require('./vote.js');

const dbConfig = {
  host: 'db',
  port: 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
};

const db = pgp(dbConfig);

//  Setup Handlebars and link with Express
const hbs = handlebars.create({
  extname: "hbs",
  layoutsDir: __dirname + "/views/layouts",
  partialsDir: __dirname + "/views/partials",
  helpers: {
    json: function(ctx) {
      return JSON.stringify(ctx)
    }
  }
});

app.engine("hbs", hbs.engine);
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
app.use(bodyParser.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    saveUninitialized: true,
    resave: true,
  })
);
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);

// Middleware

app.use(function (req, res, next) {
  // Make `user` and `authenticated` available in templates
  res.locals.user = {
    username: req.session.username,
    user_id: req.session.user_id
  }
  res.locals.authenticated = (req.session.username != undefined)
  next()
})

// Authentication Middleware.
const auth = (req, res, next) => {
  if (!req.session.username && req.path.startsWith("/account")) {
    // Default to login page.
    return res.redirect('/login');
  }
  if (req.session.username && (req.path.startsWith("/login") || req.path.startsWith("/register"))) {
    // Default to home page if the user is logged in and tries to log in again
    return res.redirect('/');
  }
  next();
};

// Authentication Required
app.use(auth);

// Begin routes

// dummy route for testing
app.get('/welcome', (req, res) => {
  res.json({status: 'success', message: 'Welcome!'});
});

// Default route
app.get("/", (req, res) => {
  res.render('pages/home')
});  

// Renders login.hbs
app.get('/login', (req, res) => {
  res.render('pages/login');
});

// API route to verify login info
// Requests username and password for query.
app.post('/login', async (req, res) => {
  const username = req.body.username || '';
  const password = req.body.password || '';

  if (!authentication.handleInputtedUserDetailsCheck(username, password, 'pages/login', res)) {
    return
  }

  let user = await authentication.getUserFromDatabase(username, db)

  if (user) { // User found!
    bcrypt.compare(password, user.password, (err, bcryptRes) => {
      if (err) { // bcrypt Error
        res.statusCode = statusCodes.BCRYPT_ERROR;
        return console.log(err)
      }
      if (bcryptRes) { // Password matches!
        res.statusCode = statusCodes.SUCCESSFUL_LOGIN;
        authentication.login(user, req, res)
      } 
      else { // Password does not match!
        let errorMsg = `Incorrect password!`
        res.statusCode = statusCodes.PASSWORD_DIDNT_MATCH;
        res.render('pages/login', {username, errorMsg});
      }
    });
  }
  else { // User not found!
    let errorMsg = `Couldnt find your account!`
    res.statusCode = statusCodes.USER_NOT_FOUND;
    res.render('pages/login', {username, errorMsg});
  }
});

// Renders register.hbs
app.get('/register', (req, res) => {
  res.render('pages/register');
});

// API route to register new account.
// Requests username and password parameter for append query.
app.post('/register', async (req, res) => {
  const username = req.body.username || '';
  const password = req.body.password || '';
  if (!authentication.handleInputtedUserDetailsCheck(username, password, 'pages/register', res)) {
    return
  }
  let user = await authentication.getUserFromDatabase(username, db)
  if (user) { // User already exists
    let errorMsg = `Username already exists.`;
    res.render('pages/register', {username, errorMsg});
    res.statusCode = statusCodes.USER_ALREADY_EXISTS;
  }
  else { // User does not yet exist
    const hash = await bcrypt.hash(password, 10)
    const query = `INSERT INTO users 
                    (username, password)
                    VALUES
                    ($1, $2)`;
    const values = [username, hash]
    db.any(query, values) 
      .then(async function (data) { // User successfully added!
        res.statusCode = statusCodes.SUCCESSFUL_REGISTRATION;
        user = await authentication.getUserFromDatabase(username, db)
        if (user) {
          authentication.login(user, req, res)
        }
        else {
          res.statusCode = statusCodes.QUERY_ERROR;
          throw new Error("Registration did not add user")
        }
      })
      .catch(function (err) { // Failed to add user!
        res.statusCode = statusCodes.FAILED_TO_ADD_USER;
        return console.log(err)
      });
  }
});


// account.hbs
app.get("/account", async (req, res) => {
  try {
    if (!req.session.username) {
      // Redirect or handle the case where there is no session user, back to login
      return res.redirect("/login");
    }

    console.log(`Username: ${req.session.username}`);

    // Fetch the reviews for the logged in user
    const query = `
      SELECT r.*, c.*, COALESCE(SUM(v.vote_amount), 0) AS total_vote
      FROM reviews r
      JOIN users u ON r.user_id = u.user_id
      JOIN courses c ON r.course_id = c.id
      LEFT JOIN votes v ON v.review_id = r.review_id
      WHERE u.username = $1
      GROUP BY r.review_id, c.id;
    `;

    const rows = await db.query(query, [req.session.username]); // Store the result in a variable
    
    console.log(`Database Rows: ${JSON.stringify(rows, null, 2)}`);
    
    res.render("pages/account", {
      username: req.session.username, // To display the username to account page
      reviews: rows // Pass the fetched reviews to account.hbs
    });
  } catch (error) { // Failed to fetch reviews
    console.error('Error fetching reviews:', error);
    res.send("Error fetching reviews");
  }
});


// API route to return the appropriate class suggestions from a keyword search
// Request: requires query parameter "keyword" which represents user search terms
//              e.g. "CSCI 2270" or "robotics" or "ASEN"
// Returns: list of matching courses, each an object with title and code
app.get("/search", async (req, res) => {
  let data = await search(req.query.keyword)
  res.send(data).status(200)
});

// API route to feed data from our database into a specific course page
// Request: requires param 'code' for the class code e.g. "CSCI2270" (no spaces)
// Returns: database information we have about the course including ratings
app.get("/course/:code", async (req, res) => {
  try {
    // assisted by ChatGPT to learn how to aggregate JSON data into a single query
    let data = await db.one(`SELECT
                              *, COALESCE(
                                (
                                  SELECT
                                    json_agg(json_build_object(
                                      'review_id', r.review_id,
                                      'year_taken', r.year_taken,
                                      'term_taken', r.term_taken,
                                      'posted_by', json_build_object(
                                        'user_id', u.user_id,
                                        'username', u.username
                                      ),
                                      'review', r.review,
                                      'overall_rating', r.overall_rating,
                                      'homework_rating', r.homework_rating,
                                      'enjoyability_rating', r.enjoyability_rating,
                                      'usefulness_rating', r.usefulness_rating,
                                      'difficulty_rating', r.difficulty_rating,
                                      'professor_id', r.professor_id,
                                      'total_vote', v.total_vote,
                                      'review_id', r.review_id
                                    )) AS reviews
                                  FROM reviews r
                                  JOIN users u ON
                                    r.user_id = u.user_id
                                  JOIN (
                                        SELECT r1.review_id AS review_id, COALESCE(SUM(v1.vote_amount), 0) AS total_vote
                                        FROM
                                          votes v1
                                          RIGHT JOIN
                                          reviews r1
                                          ON
                                          v1.review_id = r1.review_id
                                          GROUP BY
                                          r1.review_id
                                      ) AS v ON
                                    v.review_id = r.review_id
                                  WHERE
                                    r.course_id = courses.id
                                ),
                                '[]'::json
                              ) AS reviews
                            FROM courses WHERE courses.course_tag = $1 AND courses.course_id = $2;`, [req.params.code.slice(0,4), req.params.code.slice(4)])
    console.log(data)  
    data.reviews.sort((a,b) => b.total_vote - a.total_vote)                        
    res.render('pages/course', data)
  }
  catch(err) {
    if(err.message == 'No data returned from the query.') {
      const id = req.params.code.slice(4)
      const tag = req.params.code.slice(0,4)
      const info = await getCourseInfo(`${tag} ${id}`)
      if(info) {
        console.log(info)
        const c_name = info.title
        const hrs = info.credit_hours
        const desc = info.description.replace(/<[^>]*>/g, '')
        await db.none('INSERT INTO courses (course_id, course_tag, course_name, credit_hours, description) VALUES ($1, $2, $3, $4, $5);', [id, tag, c_name, hrs, desc])
        res.redirect(req.url)
      }
    }
    return res.status(404).send()
  }
});

// Renders login page and destroys user session.
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.render('pages/logout');
  })
});

// *****************************************************
// <!-- Review routes -->
// *****************************************************

//route to render the review form, pass data from tables so user doesn't select options that aren't in the database
app.get('/review', (req, res) => {
  // make sure user is logged in to write a review. 
  if (!req.session.username) {
    // Redirect or handle the case where there is no session user, back to login
    return res.redirect("/login");
  }

  //queries to get all courses and professors, we can narrow down this search later (specifically to have the professors listed match the course requested)
  const all_courses = 'SELECT * FROM courses;';
  const all_professors = 'SELECT * FROM professors;';
  db.task('get-everything', task => {
    return task.batch([task.any(all_courses), task.any(all_professors)]);
  })
  .then(results => {
    res.render('pages/review', {
      courses: results[0], 
      professors: results[1],
      message: "success",
    });
  })
  .catch(err => {
    res.render('pages/review', {
      courses: [],
      professors: [],
      message: err,
    });
  });
  
});

//Write a new review (adds review to reviews table)
//assuming that the user can press a button on the nav bar to write a review about a class (or we could have this built into the course page)
app.post('/addReview', async function (req, res) {
  //testing request
  console.log(req.body);
  console.log(req.session);
  try{

    //user won't be able to access the review form if they are not logged in, this route takes care of the submit review action
    const user_id = req.session.user_id;
    const course_id = parseInt(req.body.id);
    const professor_id = parseInt(req.body.professor_id);
    
    const review = await db.one(`INSERT INTO reviews (course_id, year_taken, term_taken, user_id, review, overall_rating, professor_id) values ($1, $2, $3, $4, $5, $6, $7) returning review_id;`, 
    [course_id, 
    parseInt(req.body.year), 
    req.body.term, 
    user_id, 
    req.body.write_review,
    parseInt(req.body.overall),
    professor_id
    ]);
    const review_id = review.review_id;
    //For the optional fields of the form, individually add these values to this review (there's definetely a better way to do this)
    if(req.body.difficulty){
      await db.any('UPDATE reviews SET difficulty_rating = ($1) WHERE review_id = ($2);',[parseInt(req.body.difficulty), review_id]);
    }
    if(req.body.enjoy){
      await db.any('UPDATE reviews SET enjoyability_rating = ($1) WHERE review_id = ($2);',[parseInt(req.body.enjoy), review_id]);
    }
    if(req.body.homework){
      await db.any('UPDATE reviews SET homework_rating = ($1) WHERE review_id = ($2);',[parseInt(req.body.homework), review_id]);
    }
    if(req.body.useful){
      await db.any('UPDATE reviews SET usefulness_rating = ($1) WHERE review_id = ($2);',[parseInt(req.body.useful), review_id]);
    }
    if(req.body.grade_recieved){
      await db.any('UPDATE reviews SET grade_recieved = ($1) WHERE review_id = ($2);',[req.body.grade_recieved, review_id]);
    }
    if(req.body.attendance_required){
      await db.any('UPDATE reviews SET grade_recieved = ($1) WHERE review_id = ($2);',[req.body.grade_recieved, review_id]);
    }
    if(review){ //if the new review successfully added to reviews table, redirect to their account page. 
        res.redirect('/account'); 
    }
  }catch(error){
    console.log(error);
    res.status(500).send();
  }
    
});

// API route to create, or modify a vote.
// Requests: query parameters, review_id and vote_amount.
app.post('/vote', async (req, res) => {
  const user_id = req.session.user_id;
  const review_id = req.body.review_id;
  const vote_amount = req.body.vote_amount;
  if (user_id === undefined) {

    res.redirect('/login');
    return;
  }
  if (review_id === undefined) {
    return console.log(`review_id not found in post request '/vote'. Please make sure review_id is defined in request body.`);
  }  
  if (vote_amount === undefined) {
    return console.log(`vote_amount not found in post request '/vote'. Please make sure vote_amount is defined in request body.`);
  }
  await vote(user_id, review_id, vote_amount, db);
  return res.status(200);
})

// API route to delete a vote.
// Requests: query parameters, review_id and amount.
app.delete('/vote', (req, res) => {
  const user_id = req.session.user_id;
  const review_id = req.body.review_id;
  console.log("vote")
  if (user_id === undefined) {
    return res.redirect('/login');
  }
  if (review_id === undefined) {
    return console.log(`review_id not found in delete request '/vote'. Please make sure review_id is defined in request body.`);
  }
  deleteVote(user_id, review_id, db);
  res.status(200);
}) 

app.get('/test', (req, res) => {
  const total_vote = 1
  res.render('pages/test', {total_vote})
})

module.exports = app.listen(3000);
console.log("Server is listening on port 3000");
 